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
 *     → { wallet: string, claims: SerializedClaim[] }
 *
 *   GET /stats
 *     → { stats: StatsRow[] }
 *
 *   GET /recent?limit=20&cursor=<opaque>
 *     → { claims: SerializedClaim[], limit: number, nextCursor: string | null }
 *
 *   GET /issuers/:issuer/stats
 *     → { issuer, total, active, revoked, credential_types: string[], first_seen: number | null }
 *
 *   GET /apps
 *     → { apps: AppSubmission[] }  (approved only)
 *
 *   GET /apps/:id
 *     → { app: AppSubmission }
 *
 *   POST /apps/submit
 *     Body: { appName, description, requiredClaims, verifyUrl, contactEmail }
 *     → { id: number, status: "pending" }
 *
 * /recent uses keyset (cursor) pagination ordered by (ledger_sequence, id) —
 * the `nextCursor` returned with each page is an opaque token that must be
 * passed back as `?cursor=` to fetch the next page. Unlike OFFSET pagination
 * this stays stable (no duplicate/skipped rows) while new claims are ingested
 * between requests, and the indexed range scan never pays OFFSET's skip cost.
 *
 * All responses are JSON. No write endpoints exist.
 * No identity fields are stored, so all data here is public chain data.
 *
 * SerializedClaim response schema (pinned by tests in api.test.ts, identical
 * across both DB_DRIVER backends — see serializeClaim below):
 *
 *   id               number   insertion cursor; the /recent tiebreaker
 *   wallet           string
 *   credential_type  string
 *   issuer           string
 *   verified_at      number   unix seconds
 *   expiry           number   unix seconds
 *   ledger_sequence  number
 *   threshold        number | null
 *   revoked          number   0 or 1 — intentionally not a boolean; this is
 *                             the shape existing consumers (SDK/UI) already
 *                             code against, so it's pinned as-is rather than
 *                             changed to avoid a breaking wire-format change.
 */

import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import type { Db, ClaimRow } from "./db";
import type { Ingester } from "./ingester";
import type { Config } from "./config";
import { parseCorsOrigins } from "./config";
import { createCorsMiddleware } from "./cors";
import { RateLimiter } from "./rate-limit";
import type { RecentCursor } from "./db";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/** Known StellarCred credential types — submissions must reference only these. */
const VALID_CLAIM_TYPES = new Set([
  "kyc",
  "age",
  "jurisdiction",
  "income",
  "funds",
  "accreditation",
  "employment",
]);

const MAX_APP_NAME = 120;
const MAX_DESCRIPTION = 2000;
const MAX_CLAIMS = 10;
const MAX_CONTACT_EMAIL = 254;

// ── Response schema (#349) ──────────────────────────────────────────────────
//
// `ClaimRow` (db.ts) is the internal row shape the two DB adapters happen to
// hand back — on Postgres, `pg` parses BIGINT columns (id, verified_at,
// expiry, ledger_sequence, threshold) as strings by default to avoid silent
// precision loss, while better-sqlite3 hands back plain JS numbers for the
// same INTEGER columns. Left unhandled, a consumer coding against one
// backend's shape breaks against the other's. `serializeClaim` is the one
// place that boundary gets normalized, and its explicit field list also
// means a future internal-only column added to the `claims` table can't
// leak into the API response by accident the way a bare `...row` spread
// would allow.

/** The wire shape every claim-bearing endpoint (/claims, /recent) returns. */
export interface SerializedClaim {
  id: number;
  wallet: string;
  credential_type: string;
  issuer: string;
  verified_at: number;
  expiry: number;
  ledger_sequence: number;
  threshold: number | null;
  /** 0 or 1 — see the module doc comment for why this isn't a boolean. */
  revoked: number;
}

export function serializeClaim(row: ClaimRow): SerializedClaim {
  return {
    id: Number(row.id),
    wallet: row.wallet,
    credential_type: row.credential_type,
    issuer: row.issuer,
    verified_at: Number(row.verified_at),
    expiry: Number(row.expiry),
    ledger_sequence: Number(row.ledger_sequence),
    threshold: row.threshold === null ? null : Number(row.threshold),
    revoked: Number(row.revoked),
  };
}

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
      res.json({ wallet: wallet.trim(), claims: claims.map(serializeClaim) });
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
        claims: claims.map(serializeClaim),
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

  // ── GET /apps ────────────────────────────────────────────────────────────
  // Returns all approved app submissions for the gallery.
  app.get(
    "/apps",
    asyncHandler(async (_req, res) => {
      const apps = await db.listApprovedApps();
      res.json({ apps });
    })
  );

  // ── GET /apps/:id ────────────────────────────────────────────────────────
  app.get(
    "/apps/:id",
    asyncHandler(async (req, res) => {
      const id = parseInt(req.params["id"], 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "invalid id" });
        return;
      }
      const appRow = await db.getAppSubmission(id);
      if (!appRow) {
        res.status(404).json({ error: "app not found" });
        return;
      }
      res.json({ app: appRow });
    })
  );

  // ── POST /apps/submit ────────────────────────────────────────────────────
  // Third parties submit their app for review.
  app.use("/apps", express.json({ limit: "16kb" }));
  app.post(
    "/apps/submit",
    asyncHandler(async (req, res) => {
      const { appName, description, requiredClaims, verifyUrl, contactEmail } =
        req.body;

      if (typeof appName !== "string" || appName.trim().length === 0) {
        res.status(400).json({ error: "appName is required" });
        return;
      }
      if (appName.trim().length > MAX_APP_NAME) {
        res.status(400).json({ error: `appName must be at most ${MAX_APP_NAME} characters` });
        return;
      }

      if (typeof description !== "string" || description.trim().length === 0) {
        res.status(400).json({ error: "description is required" });
        return;
      }
      if (description.trim().length > MAX_DESCRIPTION) {
        res.status(400).json({ error: `description must be at most ${MAX_DESCRIPTION} characters` });
        return;
      }

      if (!Array.isArray(requiredClaims) || requiredClaims.length === 0) {
        res.status(400).json({ error: "requiredClaims must be a non-empty array" });
        return;
      }
      if (requiredClaims.length > MAX_CLAIMS) {
        res.status(400).json({ error: `requiredClaims must contain at most ${MAX_CLAIMS} items` });
        return;
      }
      for (const claim of requiredClaims) {
        if (typeof claim !== "string" || !VALID_CLAIM_TYPES.has(claim)) {
          res.status(400).json({
            error: `invalid claim type: "${claim}". Valid types: ${[...VALID_CLAIM_TYPES].join(", ")}`,
          });
          return;
        }
      }

      if (typeof verifyUrl !== "string" || verifyUrl.trim().length === 0) {
        res.status(400).json({ error: "verifyUrl is required" });
        return;
      }
      try {
        const parsed = new URL(verifyUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          res.status(400).json({ error: "verifyUrl must use http or https" });
          return;
        }
      } catch {
        res.status(400).json({ error: "verifyUrl must be a valid URL" });
        return;
      }

      if (typeof contactEmail !== "string" || contactEmail.trim().length === 0) {
        res.status(400).json({ error: "contactEmail is required" });
        return;
      }
      if (contactEmail.trim().length > MAX_CONTACT_EMAIL) {
        res.status(400).json({ error: `contactEmail must be at most ${MAX_CONTACT_EMAIL} characters` });
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
        res.status(400).json({ error: "contactEmail must be a valid email address" });
        return;
      }

      const id = await db.insertAppSubmission(
        appName.trim(),
        description.trim(),
        requiredClaims.map((c: string) => c.trim()),
        verifyUrl.trim(),
        contactEmail.trim(),
      );

      res.status(201).json({ id, status: "pending" });
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
