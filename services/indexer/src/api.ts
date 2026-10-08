/**
 * api.ts — Read-only HTTP API for the indexer.
 *
 * Security & Access Model:
 *   - CORS: Configurable origin allowlist (via CORS_ORIGIN / CORS_ALLOWED_ORIGINS).
 *     Defaults to same-origin / default-deny in production; http://localhost:3000 in dev.
 *   - Rate Limiting: Per-IP fixed-window rate limiting with 429 Too Many Requests
 *     and Retry-After header. Configurable via RATE_LIMIT_WINDOW_SECONDS and RATE_LIMIT_MAX.
 *   - Authentication / API Keys: Public read endpoints do NOT require API keys.
 *     App review writes and webhook subscription management are protected by API_KEY.
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
 *   GET /integrity/status
 *     → on-chain verification metadata for #612: when the last pass ran,
 *       whether it read every sampled claim, and the most recent mismatches
 *
 *   POST /integrity/check[?sampleSize=25]
 *     Body: none
 *     → { checked, unreadable, mismatchCount, complete, durationSeconds,
 *         mismatches }  (requires API_KEY when one is configured)
 *
 *   POST /webhooks/subscriptions
 *     Body: { url, wallet, claimType } (requires API_KEY + WEBHOOK_SIGNING_SECRET)
 *     → { id, wallet, claimType }
 *
 *   GET /webhooks/subscriptions[?wallet=G…]
 *   DELETE /webhooks/subscriptions/:id
 *   GET /webhooks/subscriptions/:id/deliveries
 *
 * /recent uses keyset (cursor) pagination ordered by (ledger_sequence, id) —
 * the `nextCursor` returned with each page is an opaque token that must be
 * passed back as `?cursor=` to fetch the next page. Unlike OFFSET pagination
 * this stays stable (no duplicate/skipped rows) while new claims are ingested
 * between requests, and the indexed range scan never pays OFFSET's skip cost.
 *
 * All responses are JSON. Webhook targets receive public chain lifecycle data only.
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
 *   expired          boolean  DERIVED: expiry > 0 && expiry <= now. The
 *                             contract enforces expiry lazily in is_verified
 *                             and emits no expiry event, so this is computed
 *                             by the indexer from the indexed `expiry`
 *                             timestamp — see integrity.ts.
 *   state            "active" | "expired" | "revoked"  DERIVED: revoked
 *                             wins, then locally-expired, then active.
 *
 * Consumers that need authoritative answers for `state === "expired"` claims
 * must make the live on-chain `is_verified` / `check_claim` call: once a
 * claim's expiry passes, the contract's TTL-bumped entry can be evicted from
 * state entirely, so the chain can no longer confirm anything about it.
 */

import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import type { Db, ClaimRow, SubmissionStatus } from "./db";
import type { Ingester } from "./ingester";
import type { Config } from "./config";
import { parseCorsOrigins } from "./config";
import { createCorsMiddleware } from "./cors";
import { RateLimiter } from "./rate-limit";
import type { RecentCursor } from "./db";
import { requireAuth } from "./auth";
import { claimState, isExpired } from "./integrity";
import type { IntegrityChecker } from "./integrity";
import { isIP } from "net";
import { StrKey } from "@stellar/stellar-sdk";
import { MAX_WEBHOOK_DELIVERY_ATTEMPTS } from "./webhooks";
import { createGraphQLHandler } from "./graphql";

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
  reason_code: string;
  revoked: number;
  /** Derived, not event-sourced — see the module doc comment. */
  expired: boolean;
  /** Derived, not event-sourced — see the module doc comment. */
  state: "active" | "expired" | "revoked";
}

/**
 * `options.now` is injectable so the derived expiry fields are deterministic
 * under test; it defaults to wall-clock time at call time.
 *
 * It is an options object rather than a bare second parameter on purpose: this
 * is called as `claims.map(serializeClaim)`, and `map` hands the array *index*
 * to the second position — a bare `now` parameter would silently receive `0`.
 */
export function serializeClaim(
  row: ClaimRow,
  options: { now?: number } = {}
): SerializedClaim {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return {
    id: Number(row.id),
    wallet: row.wallet,
    credential_type: row.credential_type,
    issuer: row.issuer,
    verified_at: Number(row.verified_at),
    expiry: Number(row.expiry),
    ledger_sequence: Number(row.ledger_sequence),
    threshold: row.threshold === null ? null : Number(row.threshold),
    reason_code: row.reason_code,
    revoked: Number(row.revoked),
    expired: isExpired(row, now),
    state: claimState(row, now),
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

export function buildApp(
  db: Db,
  ingester: Ingester,
  config?: Partial<Config>,
  integrity?: IntegrityChecker
): express.Application {
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

  // ── Auth guard ───────────────────────────────────────────────────────────
  // requireAuth(undefined) → no-op; public mode, all endpoints open (default).
  // requireAuth("secret")  → enforces Bearer / X-API-Key on guarded routes.
  // Resolved from config first so tests can inject the key directly without
  // touching the environment.
  const envApiKey = process.env["API_KEY"]?.trim();
  const apiKey = config?.apiKey ?? (envApiKey || undefined);
  const guard = requireAuth(apiKey);
  const webhookSecret =
    config?.webhookSigningSecret ?? process.env["WEBHOOK_SIGNING_SECRET"];
  const webhookGuard: RequestHandler = (req, res, next) => {
    if (!apiKey || !webhookSecret || webhookSecret.length < 32) {
      res.status(503).json({
        error: "webhook subscriptions require API_KEY and a 32-character WEBHOOK_SIGNING_SECRET",
      });
      return;
    }
    guard(req, res, next);
  };

  // ── GraphQL endpoint ─────────────────────────────────────────────────────
  // Provides a flexible, typed query interface over the claims store.
  // Supports filtering by wallet, credential_type, issuer, active/revoked,
  // and time range, with cursor-based pagination.
  const graphqlHandler = createGraphQLHandler(db);
  app.use("/graphql", graphqlHandler as any);

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

      // ── On-chain data integrity (#612) ─────────────────────────────────────
      // `indexer_state_mismatches` is the alerting series: it holds the number
      // of claims in the last completed check that disagreed with the
      // contract. It is a gauge, not a counter, so an alert can fire on "the
      // indexer is currently wrong about N claims" and clear on its own once a
      // later check (or a fix + reindex) resolves the drift. Only successfully
      // read claims can produce a mismatch, so an RPC outage moves
      // `indexer_state_check_errors` instead and never fakes a mismatch.
      if (integrity) {
        const im = integrity.getMetrics();

        lines.push(
          `# HELP indexer_state_mismatches Indexed claims that disagreed with on-chain contract state in the last completed integrity check.`,
        );
        lines.push(`# TYPE indexer_state_mismatches gauge`);
        lines.push(`indexer_state_mismatches ${im.lastMismatchCount}`);

        lines.push(
          `# HELP indexer_state_checked Claims compared against contract state in the last completed integrity check.`,
        );
        lines.push(`# TYPE indexer_state_checked gauge`);
        lines.push(`indexer_state_checked ${im.lastCheckedCount}`);

        lines.push(
          `# HELP indexer_state_mismatches_total Cumulative mismatches since the indexer started.`,
        );
        lines.push(`# TYPE indexer_state_mismatches_total counter`);
        lines.push(`indexer_state_mismatches_total ${im.mismatchesTotal}`);

        for (const [kind, count] of Object.entries(im.mismatchesByKind)) {
          lines.push(
            `# HELP indexer_state_mismatches_by_kind Cumulative mismatches by kind since the indexer started.`,
          );
          lines.push(`# TYPE indexer_state_mismatches_by_kind counter`);
          lines.push(
            `indexer_state_mismatches_by_kind{kind="${kind}"} ${count}`,
          );
        }

        lines.push(
          `# HELP indexer_state_checks_total Integrity checks run since the indexer started.`,
        );
        lines.push(`# TYPE indexer_state_checks_total counter`);
        lines.push(`indexer_state_checks_total ${im.checksTotal}`);

        lines.push(
          `# HELP indexer_state_checks_incomplete_total Integrity checks in which at least one sampled claim could not be read from the contract.`,
        );
        lines.push(`# TYPE indexer_state_checks_incomplete_total counter`);
        lines.push(
          `indexer_state_checks_incomplete_total ${im.checksIncompleteTotal}`,
        );

        lines.push(
          `# HELP indexer_state_check_errors Sampled claims the last integrity check could not read from the contract.`,
        );
        lines.push(`# TYPE indexer_state_check_errors gauge`);
        lines.push(`indexer_state_check_errors ${im.lastUnreadableCount}`);

        lines.push(
          `# HELP indexer_state_last_check_timestamp_seconds Unix time of the last completed integrity check; 0 if none has run.`,
        );
        lines.push(`# TYPE indexer_state_last_check_timestamp_seconds gauge`);
        lines.push(
          `indexer_state_last_check_timestamp_seconds ${im.lastRunTimestampSeconds}`,
        );

        lines.push(
          `# HELP indexer_state_last_success_timestamp_seconds Unix time of the last integrity check that read every sampled claim; 0 if none has.`,
        );
        lines.push(`# TYPE indexer_state_last_success_timestamp_seconds gauge`);
        lines.push(
          `indexer_state_last_success_timestamp_seconds ${im.lastSuccessTimestampSeconds}`,
        );

        lines.push(
          `# HELP indexer_state_last_check_duration_seconds Duration of the last completed integrity check.`,
        );
        lines.push(`# TYPE indexer_state_last_check_duration_seconds gauge`);
        lines.push(
          `indexer_state_last_check_duration_seconds ${im.lastDurationSeconds}`,
        );
      }

      res.type("text/plain").send(lines.join("\n") + "\n");
    })
  );

  // ── GET /integrity/status ────────────────────────────────────────────────
  // Operational metadata about the on-chain state verification routine (#612):
  // when it last ran, whether it read every sampled claim, and the most recent
  // mismatches. Public like /health and /metrics — it reports indexer health,
  // not wallet data — and omitted entirely when no checker is wired in.
  app.get(
    "/integrity/status",
    asyncHandler(async (_req, res) => {
      if (!integrity) {
        res.status(404).json({ error: "integrity checks are not configured" });
        return;
      }
      const report = integrity.getLastReport();
      const metrics = integrity.getMetrics();
      res.json({
        lastRunTimestamp: report?.finishedAt ?? null,
        lastSuccessTimestamp: metrics.lastSuccessTimestampSeconds
          ? metrics.lastSuccessTimestampSeconds * 1000
          : null,
        checksTotal: metrics.checksTotal,
        checksIncompleteTotal: metrics.checksIncompleteTotal,
        mismatchCount: metrics.lastMismatchCount,
        mismatchesTotal: metrics.mismatchesTotal,
        lastCheckedCount: metrics.lastCheckedCount,
        lastUnreadableCount: metrics.lastUnreadableCount,
        lastError: metrics.lastError,
        mismatches: report?.mismatches ?? [],
      });
    })
  );

  // ── POST /integrity/check ────────────────────────────────────────────────
  // On-demand trigger for the same routine the schedule runs. Gated by API_KEY
  // like the other expensive operations: each call costs one RPC read per
  // sampled claim, and it moves the rotating sample cursor, so an unauthenticated
  // caller could both exhaust the RPC quota and starve the periodic sweep.
  app.post(
    "/integrity/check",
    guard,
    asyncHandler(async (req, res) => {
      if (!integrity) {
        res.status(404).json({ error: "integrity checks are not configured" });
        return;
      }
      const raw = req.query["sampleSize"];
      const parsed = raw === undefined ? NaN : Number(raw);
      if (raw !== undefined && (!Number.isInteger(parsed) || parsed < 1)) {
        res.status(400).json({
          error: "sampleSize must be a positive integer",
        });
        return;
      }
      const report = await integrity.run(
        parsed ? { sampleSize: parsed } : undefined
      );
      res.json({
        checked: report.checked,
        unreadable: report.unreadable,
        mismatchCount: report.mismatchCount,
        complete: report.complete,
        durationSeconds: report.durationSeconds,
        mismatches: report.mismatches,
      });
    })
  );

  // ── GET /claims?wallet=G… ────────────────────────────────────────────────
  // Gated when API_KEY is set: per-wallet claim history makes per-holder
  // correlation much easier than per-ledger chain queries.
  app.get(
    "/claims",
    guard,
    asyncHandler(async (req, res) => {
      const wallet = req.query["wallet"];
      if (typeof wallet !== "string" || wallet.trim() === "") {
        res.status(400).json({
          error: "wallet query parameter is required",
        });
        return;
      }

      const claims = await db.claimsByWallet(wallet.trim());
      res.json({ wallet: wallet.trim(), claims: claims.map((row) => serializeClaim(row)) });
    })
  );

  // ── GET /stats ───────────────────────────────────────────────────────────
  // Gated when API_KEY is set: reveals total verified-holder counts per type.
  app.get(
    "/stats",
    guard,
    asyncHandler(async (_req, res) => {
      const stats = await db.stats();
      res.json({ stats });
    })
  );

  // ── GET /recent?limit=20&cursor=<opaque> ──────────────────────────────────
  app.get(
    "/recent",
    guard,
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
        claims: claims.map((row) => serializeClaim(row)),
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

  // ── GET /issuers/:issuer/credentials ──────────────────────────────────────
  // Returns all credentials issued by this issuer, for the revocation dashboard (#540).
  app.get(
    "/issuers/:issuer/credentials",
    asyncHandler(async (req, res) => {
      const issuer = req.params["issuer"];
      if (typeof issuer !== "string" || issuer.trim() === "") {
        res.status(400).json({ error: "issuer path parameter is required" });
        return;
      }
      const rawClaims = await db.claimsByIssuer(issuer.trim());
      res.json({
        issuer: issuer.trim(),
        credentials: rawClaims.map((row) => serializeClaim(row)),
      });
    })
  );

  // ── GET /issuers/:issuer/analytics ────────────────────────────────────────
  // Verification volume over time, success rates, top verifiers, and exportable events (#542).
  app.get(
    "/issuers/:issuer/analytics",
    asyncHandler(async (req, res) => {
      const issuer = req.params["issuer"];
      if (typeof issuer !== "string" || issuer.trim() === "") {
        res.status(400).json({ error: "issuer path parameter is required" });
        return;
      }
      const analytics = await db.issuerAnalytics(issuer.trim());
      res.json(analytics);
    })
  );

  // ── GET /credentials/:commitment/events ───────────────────────────────────
  // Returns on-chain lifecycle events for a specific credential commitment (#541).
  app.get(
    "/credentials/:commitment/events",
    asyncHandler(async (req, res) => {
      const commitment = req.params["commitment"];
      if (typeof commitment !== "string" || commitment.trim() === "") {
        res.status(400).json({ error: "commitment path parameter is required" });
        return;
      }
      const wallet = typeof req.query["wallet"] === "string" ? req.query["wallet"].trim() : undefined;
      const type = typeof req.query["type"] === "string" ? req.query["type"].trim() : undefined;

      const history = await db.credentialEvents(commitment.trim(), wallet, type);
      res.json(history);
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

  // ── PATCH /apps/:id/status ───────────────────────────────────────────────
  // Update submission review status (approved | rejected | pending).
  app.patch(
    "/apps/:id/status",
    guard,
    asyncHandler(async (req, res) => {
      const id = parseInt(req.params["id"], 10);
      if (isNaN(id)) {
        res.status(400).json({ error: "invalid id" });
        return;
      }
      const { status } = req.body ?? {};
      if (status !== "approved" && status !== "rejected" && status !== "pending") {
        res.status(400).json({ error: "status must be one of: approved, rejected, pending" });
        return;
      }
      const existing = await db.getAppSubmission(id);
      if (!existing) {
        res.status(404).json({ error: "app not found" });
        return;
      }
      await db.updateSubmissionStatus(id, status as SubmissionStatus);
      const updated = await db.getAppSubmission(id);
      res.json({ app: updated });
    })
  );

  // ── Webhook subscriptions (#635) ────────────────────────────────────────
  app.use("/webhooks", express.json({ limit: "16kb" }));
  app.post(
    "/webhooks/subscriptions",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const { url, wallet, claimType } = req.body ?? {};
      if (typeof url !== "string" || url.length > 2048) {
        res.status(400).json({ error: "url must be a valid HTTPS URL" });
        return;
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        res.status(400).json({ error: "url must be a valid HTTPS URL" });
        return;
      }
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.username ||
        parsedUrl.password ||
        parsedUrl.hostname.length === 0 ||
        isIP(parsedUrl.hostname) !== 0 ||
        parsedUrl.hostname === "localhost" ||
        parsedUrl.hostname.endsWith(".localhost") ||
        parsedUrl.hostname.endsWith(".local")
      ) {
        res.status(400).json({
          error: "url must be an HTTPS URL with a public DNS hostname and no credentials",
        });
        return;
      }
      if (
        typeof wallet !== "string" ||
        !StrKey.isValidEd25519PublicKey(wallet)
      ) {
        res.status(400).json({ error: "wallet must be a valid Stellar public key" });
        return;
      }
      if (typeof claimType !== "string" || !VALID_CLAIM_TYPES.has(claimType)) {
        res.status(400).json({
          error: `claimType must be one of: ${[...VALID_CLAIM_TYPES].join(", ")}`,
        });
        return;
      }

      const id = await db.createWebhookSubscription({
        url: parsedUrl.toString(),
        wallet,
        credential_type: claimType,
      });
      res.status(201).json({ id, wallet, claimType });
    }),
  );

  app.get(
    "/webhooks/subscriptions",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const wallet = req.query["wallet"];
      if (wallet !== undefined && typeof wallet !== "string") {
        res.status(400).json({ error: "wallet must be a single value" });
        return;
      }
      res.json({
        subscriptions: await db.listWebhookSubscriptions(wallet as string | undefined),
      });
    }),
  );

  app.delete(
    "/webhooks/subscriptions/:id",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const id = Number(req.params["id"]);
      if (!Number.isSafeInteger(id) || id < 1) {
        res.status(400).json({ error: "id must be a positive integer" });
        return;
      }
      if (!(await db.deleteWebhookSubscription(id))) {
        res.status(404).json({ error: "subscription not found" });
        return;
      }
      res.status(204).end();
    }),
  );

  app.get(
    "/webhooks/subscriptions/:id/deliveries",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const id = Number(req.params["id"]);
      if (!Number.isSafeInteger(id) || id < 1) {
        res.status(400).json({ error: "id must be a positive integer" });
        return;
      }
      const subscriptions = await db.listWebhookSubscriptions();
      if (!subscriptions.some((subscription) => subscription.id === id)) {
        res.status(404).json({ error: "subscription not found" });
        return;
      }
      const deliveries = await db.webhookDeliveries(id, 100);
      res.json({
        deliveries: deliveries.map((delivery) => ({
          id: delivery.id,
          eventId: delivery.event_id,
          type: delivery.type,
          wallet: delivery.wallet,
          claimType: delivery.credential_type,
          expiry: delivery.expiry,
          ledgerSequence: delivery.ledger_sequence,
          occurredAt: delivery.occurred_at,
          reasonCode: delivery.reason_code,
          attempts: delivery.attempts,
          status: delivery.delivered_at !== null
            ? "delivered"
            : delivery.attempts >= MAX_WEBHOOK_DELIVERY_ATTEMPTS
              ? "failed"
              : "retrying",
          deliveredAt: delivery.delivered_at,
          lastError: delivery.last_error,
        })),
      });
    }),
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
