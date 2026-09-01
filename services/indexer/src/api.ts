/**
 * api.ts — Read-only HTTP API for the indexer.
 *
 * Security & Access Model:
 *   - CORS: Configurable origin allowlist (via CORS_ORIGIN / CORS_ALLOWED_ORIGINS).
 *     Defaults to same-origin / default-deny in production; http://localhost:3000 in dev.
 *   - Rate Limiting: Per-IP fixed-window rate limiting with 429 Too Many Requests
 *     and Retry-After header. Configurable via RATE_LIMIT_WINDOW_SECONDS and RATE_LIMIT_MAX.
 *   - Authentication / API Keys: Public read endpoints do NOT require API keys.
 *     The indexer only serves public, non-sensitive ledger state (claims, stats, recent events)
 *     and contains no write endpoints or identity data. Keeping read access keyless ensures
 *     frictionless composability for dApps, wallets, and community explorers.
 *     Scraping and DoS risks are mitigated via per-IP rate limiting and CORS enforcement.
 *
 * Endpoints:
 *
 *   GET /health
 *     → { status, lastLedger, headLedger, lag, lastError, lastErrorTime,
 *         consecutiveErrors, fetchAttempts, fetchFailures }
 *
 *   GET /claims?wallet=G…
 *     → { wallet: string, claims: ClaimRow[] }
 *
 *   GET /stats
 *     → { stats: StatsRow[] }
 *
 *   GET /recent?limit=20&cursor=<opaque>
 *     → { claims: ClaimRow[], limit: number, nextCursor: string | null }
 *
 *   GET /issuers/:issuer/stats
 *     → { issuer, total, active, revoked, credential_types: string[], first_seen: number | null }
 *
 * /recent uses keyset (cursor) pagination ordered by (ledger_sequence, id) —
 * the `nextCursor` returned with each page is an opaque token that must be
 * passed back as `?cursor=` to fetch the next page. Unlike OFFSET pagination
 * this stays stable (no duplicate/skipped rows) while new claims are ingested
 * between requests, and the indexed range scan never pays OFFSET's skip cost.
 *
 * All responses are JSON. No write endpoints exist.
 * No identity fields are stored, so all data here is public chain data.
 */

import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import type { Db } from "./db";
import type { Ingester } from "./ingester";
import type { Config } from "./config";
import { parseCorsOrigins } from "./config";
import { createCorsMiddleware } from "./cors";
import { RateLimiter } from "./rate-limit";
import type { RecentCursor } from "./db";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

// ── Opaque cursor encoding ───────────────────────────────────────────────────
// The nextCursor token is the base64url form of "<ledgerSequence>:<id>" — the
// keyset boundary of the last row on the page. It is opaque to clients: they
// must echo it back verbatim, never construct or interpret it.

function encodeCursor(cursor: RecentCursor): string {
  return Buffer.from(`${cursor.ledgerSequence}:${cursor.id}`, "utf8").toString(
    "base64url"
  );
}

function decodeCursor(raw: string): RecentCursor {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const [ledgerRaw, idRaw] = decoded.split(":");
  const ledgerSequence = Number(ledgerRaw);
  const id = Number(idRaw);
  if (
    !Number.isInteger(ledgerSequence) ||
    !Number.isInteger(id) ||
    ledgerSequence < 0 ||
    id < 1
  ) {
    throw new Error("invalid cursor");
  }
  return { ledgerSequence, id };
}

// Helper: wrap an async handler and forward errors to next()
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function buildApp(db: Db, ingester: Ingester, config?: Partial<Config>): express.Application {
  const app = express();

  // Trust reverse proxies (e.g. AWS ALB, Cloudflare, Nginx) so client IP extraction is accurate.
  app.set("trust proxy", true);

  // Security: no body parsing (read-only), conservative headers.
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // ── CORS ─────────────────────────────────────────────────────────────────
  const corsOrigins =
    config?.corsOrigins ??
    parseCorsOrigins(process.env["CORS_ALLOWED_ORIGINS"] ?? process.env["CORS_ORIGIN"]);
  app.use(createCorsMiddleware(corsOrigins));

  // ── Rate Limiting ────────────────────────────────────────────────────────
  const windowMs =
    config?.rateLimitWindowMs ??
    Number(process.env["RATE_LIMIT_WINDOW_SECONDS"] ?? "60") * 1000;
  const max =
    config?.rateLimitMax ??
    Number(
      process.env["RATE_LIMIT_MAX"] ??
        process.env["RATE_LIMIT_MAX_REQUESTS"] ??
        "120"
    );
  const enabled =
    config?.rateLimitEnabled ??
    (process.env["RATE_LIMIT_ENABLED"]?.toLowerCase() !== "false");

  const rateLimiter = new RateLimiter({ windowMs, max, enabled });
  app.locals["rateLimiter"] = rateLimiter;
  app.use(rateLimiter.middleware());

  // ── GET /health ──────────────────────────────────────────────────────────
  // Exposes ingester lag so operators can alert when the indexer falls behind.
  //
  // status semantics:
  //   "ok"       — consecutiveErrors === 0
  //   "degraded" — last fetch failed but some succeeded before it
  //   "error"    — 3+ consecutive failures (stale data, indexer likely stalled)
  app.get(
    "/health",
    asyncHandler(async (_req, res) => {
      const lastLedger = await db.getLastLedger();
      const h = ingester.getHealth();

      let status: "ok" | "degraded" | "error";
      if (h.consecutiveErrors === 0) {
        status = "ok";
      } else if (h.consecutiveErrors < 3) {
        status = "degraded";
      } else {
        status = "error";
      }

      res.json({
        status,
        lastLedger,
        headLedger: h.headLedger,
        lag: h.lag,
        lastSuccessLedger: h.lastSuccessLedger,
        lastError: h.lastError,
        lastErrorTime: h.lastErrorTime,
        consecutiveErrors: h.consecutiveErrors,
        fetchAttempts: h.fetchAttempts,
        fetchFailures: h.fetchFailures,
      });
    })
  );

  // ── GET /metrics ──────────────────────────────────────────────────────────
  // Exposes Prometheus metrics for the indexer.
  //   - indexer_events_processed_total: total events processed since start
  //   - indexer_fetch_errors_total: total fetch errors since start
  //   - indexer_uptime_seconds: uptime in seconds since start
  //   - indexer_db_write_latency_seconds: latest tick DB write latency in seconds
  //   - indexer_ledgers_behind_head: ledgers between head and last processed
  //
  // This endpoint is left public (no auth required) so monitoring stacks can
  // scrape it, but it is separate from the claim API routes so it is not
  // colliding with public dApp/wallet endpoints. If operators want to gate it,
  // they can add a reverse-proxy or firewall rule in front of /metrics.
  app.get(
    "/metrics",
    asyncHandler(async (_req, res) => {
      const metrics = ingester.getMetrics();
      const lines: string[] = [];

      // Events processed total
      lines.push(
        `# HELP indexer_events_processed_total Total number of events processed since the ingester started.`,
      );
      lines.push(
        `# TYPE indexer_events_processed_total counter`,
      );
      lines.push(`indexer_events_processed_total ${metrics.eventsProcessedTotal}`);

      // Fetch errors total
      lines.push(
        `# HELP indexer_fetch_errors_total Total number of fetch errors (all retries exhausted) since start.`,
      );
      lines.push(
        `# TYPE indexer_fetch_errors_total counter`,
      );
      lines.push(`indexer_fetch_errors_total ${metrics.fetchErrorsTotal}`);

      // Uptime in seconds
      lines.push(
        `# HELP indexer_uptime_seconds Uptime in seconds since the ingester started.`,
      );
      lines.push(
        `# TYPE indexer_uptime_seconds gauge`,
      );
      lines.push(`indexer_uptime_seconds ${metrics.uptimeSeconds}`);

      // DB write latency in seconds
      lines.push(
        `# HELP indexer_db_write_latency_seconds Latest tick DB write latency in seconds.`,
      );
      lines.push(
        `# TYPE indexer_db_write_latency_seconds gauge`,
      );
      lines.push(`indexer_db_write_latency_seconds ${metrics.dbWriteLatencySeconds}`);

      // Ledgers behind head
      lines.push(
        `# HELP indexer_ledgers_behind_head Number of ledgers between network head and last processed ledger.`,
      );
      lines.push(
        `# TYPE indexer_ledgers_behind_head gauge`,
      );
      lines.push(`indexer_ledgers_behind_head ${metrics.lag}`);

      res.type("text/plain").send(lines.join("\n") + "\n");
    })
  );

  // ── GET /claims?wallet=G… ────────────────────────────────────────────────
  app.get(
    "/claims",
    asyncHandler(async (req, res) => {
      const wallet = req.query["wallet"];
      if (typeof wallet !== "string" || wallet.trim() === "") {
        res.status(400).json({
          error: "wallet query parameter is required",
        });
        return;
      }

      const claims = await db.claimsByWallet(wallet.trim());
      res.json({ wallet: wallet.trim(), claims });
    })
  );

  // ── GET /stats ───────────────────────────────────────────────────────────
  app.get(
    "/stats",
    asyncHandler(async (_req, res) => {
      const stats = await db.stats();
      res.json({ stats });
    })
  );

  // ── GET /recent?limit=20&cursor=<opaque> ──────────────────────────────────
  app.get(
    "/recent",
    asyncHandler(async (req, res) => {
      const rawLimit = parseInt(String(req.query["limit"] ?? DEFAULT_LIMIT), 10);
      const limit = isNaN(rawLimit) || rawLimit < 1
        ? DEFAULT_LIMIT
        : Math.min(rawLimit, MAX_LIMIT);

      // Cursor is optional — omit it (or pass cursor=) to start at the newest
      // claims. A malformed cursor is a client error, not silently page 1.
      const rawCursor = req.query["cursor"];
      let cursor: RecentCursor | null = null;
      if (rawCursor != null && String(rawCursor).trim() !== "") {
        try {
          cursor = decodeCursor(String(rawCursor));
        } catch {
          res.status(400).json({ error: "invalid cursor" });
          return;
        }
      }

      const { claims, nextCursor } = await db.recent(limit, cursor);
      res.json({
        claims,
        limit,
        nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
      });
    })
  );

  // ── GET /issuers/:issuer/stats ───────────────────────────────────────────
  // Reputation stats derived entirely from indexed events (#398) — how many
  // credentials an issuer has issued, active vs revoked, which credential
  // types they cover, and how long they've been indexed. Public: this is the
  // same class of aggregate chain data /stats already exposes, just sliced
  // by issuer instead of by credential_type.
  app.get(
    "/issuers/:issuer/stats",
    asyncHandler(async (req, res) => {
      const issuer = req.params["issuer"];
      if (typeof issuer !== "string" || issuer.trim() === "") {
        res.status(400).json({ error: "issuer path parameter is required" });
        return;
      }
      const stats = await db.issuerStats(issuer.trim());
      res.json(stats);
    })
  );

  // ── 404 ──────────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // ── Error handler ────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[indexer/api] unhandled error:", err);
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
