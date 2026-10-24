/**
 * health.ts — Health/readiness payload for the indexer service.
 *
 * A single, well-defined shape that deployment and monitoring tooling (Docker
 * `HEALTHCHECK`, Kubernetes liveness/readiness probes, load-balancer health
 * checks) can poll. It is derived from the ingester's health snapshot and the
 * database cursor so callers get both a coarse `status` and the underlying
 * numbers that produced it.
 *
 * Status semantics (kept in sync with the `/health` route in api.ts):
 *   "ok"       — no consecutive fetch errors; data is flowing.
 *   "degraded" — a fetch failed but recent history is otherwise healthy
 *                (fewer than DEGRADED_ERROR_THRESHOLD consecutive failures).
 *   "error"    — DEGRADED_ERROR_THRESHOLD or more consecutive failures; the
 *                indexer is very likely stalled and its data may be stale.
 *
 * `ready` is the readiness signal for routing traffic: the process is up,
 * the database is reachable (getLastLedger resolved), and the ingester is not
 * in the "error" state. It is `false` on an unhandled error.
 *
 * See docs/HEALTHCHECKS.md for the full contract and integration guidance.
 */

import type { Db } from "./db";
import type { Ingester, IngesterHealth } from "./ingester";

/** Consecutive fetch failures at or above which status becomes "error". */
export const DEGRADED_ERROR_THRESHOLD = 3;

/** Stable service identifier used by deployment and monitoring tooling. */
export const SERVICE_NAME = "stellarcred-indexer";

/**
 * Resolve the deployed indexer version without a runtime `package.json` read.
 *
 * `INDEXER_VERSION` is the explicit override a deployment sets (containers
 * started with a bare `node` command have no npm context); `npm_package_version`
 * is set by npm when the service is started through its package scripts. Either
 * one identifies the running build; otherwise the field falls back to a
 * non-empty placeholder so the response shape never changes.
 */
export function resolveVersion(): string {
  return (
    process.env["INDEXER_VERSION"]?.trim() ||
    process.env["npm_package_version"]?.trim() ||
    "dev"
  );
}

export type HealthStatus = "ok" | "degraded" | "error";

export interface HealthResponse {
  /** Coarse overall status — see the module doc comment. */
  status: HealthStatus;
  /** Whether the service should receive traffic. */
  ready: boolean;
  /** Stable service name. */
  service: string;
  /** Deployed version (from npm_package_version), or "dev". */
  version: string;
  /** Unix ms the payload was produced. */
  timestamp: number;
  /** Process uptime in seconds. */
  uptimeSeconds: number;
  /** Ledger sequence of the most recently persisted event (0 if none). */
  lastLedger: number;
  /** Current chain head ledger as observed by the ingester (0 if unknown). */
  headLedger: number;
  /** `headLedger - lastLedger`, or -1 if the head is unknown. */
  lag: number;
  /** Consecutive failed fetch ticks (0 = healthy). */
  consecutiveErrors: number;
  /** Message from the most recent failed fetch, if any. */
  lastError: string | null;
  /** Timestamp (ms) of the most recent failed fetch, if any. */
  lastErrorTime: number | null;
  /**
   * Set only when the check could not complete normally — currently that means
   * the database read failed. The payload is still a well-formed health
   * document so a probe can parse every response with one code path.
   */
  error?: string;
}

/** Map an ingester snapshot to the coarse health status. */
export function statusFromHealth(health: Pick<IngesterHealth, "consecutiveErrors">): HealthStatus {
  if (health.consecutiveErrors === 0) return "ok";
  if (health.consecutiveErrors < DEGRADED_ERROR_THRESHOLD) return "degraded";
  return "error";
}

/**
 * Build the health payload. `getLastLedger` is awaited so a database outage
 * surfaces as a thrown error (the caller maps that to a 503) rather than being
 * silently reported as healthy.
 */
export async function buildHealthResponse(
  db: Pick<Db, "getLastLedger">,
  ingester: Pick<Ingester, "getHealth">,
  options: { now?: number; uptimeSeconds?: number } = {},
): Promise<HealthResponse> {
  const lastLedger = Number(await db.getLastLedger());
  const h = ingester.getHealth();
  const status = statusFromHealth(h);

  return {
    ...baseFields(options),
    status,
    ready: status !== "error",
    lastLedger,
    headLedger: h.headLedger,
    lag: h.lag,
    consecutiveErrors: h.consecutiveErrors,
    lastError: h.lastError,
    lastErrorTime: h.lastErrorTime,
  };
}

/**
 * Build the health payload for the case where the database could not be read.
 *
 * The process is alive but cannot serve data, so readiness fails: `status` is
 * "error" and `ready` is false. The caller answers with HTTP 503 so a probe
 * can tell "not ready" apart from "process gone", and the payload keeps the
 * same shape as a successful check.
 */
export function buildUnavailableHealthResponse(
  ingester: Pick<Ingester, "getHealth">,
  error: unknown,
  options: { now?: number; uptimeSeconds?: number } = {},
): HealthResponse {
  const h = ingester.getHealth();

  return {
    ...baseFields(options),
    status: "error",
    ready: false,
    lastLedger: 0,
    headLedger: h.headLedger,
    lag: h.lag,
    consecutiveErrors: h.consecutiveErrors,
    lastError: h.lastError,
    lastErrorTime: h.lastErrorTime,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** Fields every health payload carries, regardless of the outcome. */
function baseFields(options: { now?: number; uptimeSeconds?: number }): Pick<
  HealthResponse,
  "service" | "version" | "timestamp" | "uptimeSeconds"
> {
  return {
    service: SERVICE_NAME,
    version: resolveVersion(),
    timestamp: options.now ?? Date.now(),
    uptimeSeconds: options.uptimeSeconds ?? Math.round(process.uptime()),
  };
}
