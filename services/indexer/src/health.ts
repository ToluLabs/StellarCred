/**
 * health.ts — Health payload for the indexer worker.
 *
 * Gives deployment and monitoring tooling (Docker HEALTHCHECK, Kubernetes
 * probes, load-balancer checks) one well-defined shape to poll, derived from
 * the ingester's health snapshot and the database cursor.
 *
 * Status semantics:
 *   "ok"       — no consecutive fetch errors; data is flowing.
 *   "degraded" — a fetch failed, but fewer than ERROR_THRESHOLD in a row.
 *   "error"    — ERROR_THRESHOLD or more consecutive failures; the ingester
 *                is very likely stalled and its data may be stale.
 *
 * `ready` is true unless status is "error".
 *
 * See docs/HEALTHCHECKS.md for the full contract.
 */

import type { IngesterHealth } from "./ingester";

/** Consecutive fetch failures at or above which status becomes "error". */
export const ERROR_THRESHOLD = 3;

/** Maximum ledger lag allowed for the Horizon/ingester readiness check. */
export const MAX_READY_LEDGER_LAG = 5;

/** Stable service identifier reported in every health response. */
export const SERVICE_NAME = "stellarcred-indexer";

export type HealthStatus = "ok" | "degraded" | "error";

export interface DatabaseCheckResult {
  status: "ok" | "error";
  latencyMs: number;
  lastLedger: number | null;
  error: string | null;
}

export interface HorizonCheckResult {
  status: HealthStatus;
  synced: boolean;
  headLedger: number;
  lastSuccessLedger: number;
  lag: number;
  maxLag: number;
  consecutiveErrors: number;
  lastError: string | null;
}

export interface LivenessResponse {
  status: "ok";
  alive: true;
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessResponse {
  status: HealthStatus;
  ready: boolean;
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: {
    database: DatabaseCheckResult;
    horizon: HorizonCheckResult;
  };
}

export interface HealthzResponse extends ReadinessResponse {
  alive: true;
  lastLedger: number | null;
  headLedger: number;
  lag: number;
  lastSuccessLedger: number;
  lastError: string | null;
  lastErrorTime: number | null;
  consecutiveErrors: number;
  fetchAttempts: number;
  fetchFailures: number;
}

export interface IndexerHealthResponse {
  status: HealthStatus;
  ready: boolean;
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  lastLedger: number;
  headLedger: number;
  lag: number;
  lastSuccessLedger: number;
  lastError: string | null;
  lastErrorTime: number | null;
  consecutiveErrors: number;
  fetchAttempts: number;
  fetchFailures: number;
}

/**
 * Deployed version: INDEXER_VERSION when set by the deployment, otherwise
 * npm_package_version (set when started via npm scripts), otherwise "dev".
 */
export function resolveVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.INDEXER_VERSION || env.npm_package_version || "dev";
}

export function statusFromHealth(h: Pick<IngesterHealth, "consecutiveErrors">): HealthStatus {
  if (h.consecutiveErrors === 0) return "ok";
  if (h.consecutiveErrors < ERROR_THRESHOLD) return "degraded";
  return "error";
}

export function buildHealthResponse(
  lastLedger: number,
  h: IngesterHealth,
  now: Date = new Date()
): IndexerHealthResponse {
  const status = statusFromHealth(h);
  return {
    status,
    ready: status !== "error",
    service: SERVICE_NAME,
    version: resolveVersion(),
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: now.toISOString(),
    lastLedger,
    headLedger: h.headLedger,
    lag: h.lag,
    lastSuccessLedger: h.lastSuccessLedger,
    lastError: h.lastError,
    lastErrorTime: h.lastErrorTime,
    consecutiveErrors: h.consecutiveErrors,
    fetchAttempts: h.fetchAttempts,
    fetchFailures: h.fetchFailures,
  };
}

/**
 * Probes database connectivity by querying the current ledger cursor and
 * measuring round-trip latency. Never throws — failures are captured in the
 * returned check object so readiness/healthz endpoints can return structured 503s.
 */
export async function checkDatabase(
  probe: () => number | Promise<number>
): Promise<DatabaseCheckResult> {
  const start = Date.now();
  try {
    const lastLedger = await probe();
    return {
      status: "ok",
      latencyMs: Date.now() - start,
      lastLedger,
      error: null,
    };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      lastLedger: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Evaluates Stellar Horizon / ingester sync state against both consecutive
 * error thresholds and the maximum allowed ledger lag (default: 5 ledgers).
 */
export function evaluateHorizonHealth(
  h: IngesterHealth,
  maxLag: number = MAX_READY_LEDGER_LAG
): HorizonCheckResult {
  const synced = h.lag >= 0 && h.lag <= maxLag;
  const baseStatus = statusFromHealth(h);

  let status: HealthStatus;
  let lastError = h.lastError;

  if (baseStatus === "error" || !synced) {
    status = "error";
    if (!lastError && !synced) {
      lastError =
        h.lag < 0
          ? "Horizon head ledger not yet synced"
          : `Horizon lag (${h.lag}) exceeds maximum allowed (${maxLag} ledgers)`;
    }
  } else {
    status = baseStatus;
  }

  return {
    status,
    synced,
    headLedger: h.headLedger,
    lastSuccessLedger: h.lastSuccessLedger,
    lag: h.lag,
    maxLag,
    consecutiveErrors: h.consecutiveErrors,
    lastError,
  };
}

/** Liveness probe (/livez): process is alive and serving HTTP requests. */
export function buildLivenessResponse(now: Date = new Date()): LivenessResponse {
  return {
    status: "ok",
    alive: true,
    service: SERVICE_NAME,
    version: resolveVersion(),
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: now.toISOString(),
  };
}

/**
 * Readiness probe (/readyz): checks deep dependencies (database connectivity
 * and Stellar Horizon sync within maxLag ledgers).
 */
export function buildReadinessResponse(
  database: DatabaseCheckResult,
  h: IngesterHealth,
  now: Date = new Date(),
  maxLag: number = MAX_READY_LEDGER_LAG
): ReadinessResponse {
  const horizon = evaluateHorizonHealth(h, maxLag);
  const ready = database.status === "ok" && horizon.status !== "error";

  let status: HealthStatus;
  if (!ready) {
    status = "error";
  } else if (horizon.status === "degraded") {
    status = "degraded";
  } else {
    status = "ok";
  }

  return {
    status,
    ready,
    service: SERVICE_NAME,
    version: resolveVersion(),
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: now.toISOString(),
    checks: {
      database,
      horizon,
    },
  };
}

/**
 * Combined deep health probe (/healthz): liveness + readiness + ingester metrics.
 */
export function buildHealthzResponse(
  database: DatabaseCheckResult,
  h: IngesterHealth,
  now: Date = new Date(),
  maxLag: number = MAX_READY_LEDGER_LAG
): HealthzResponse {
  const readiness = buildReadinessResponse(database, h, now, maxLag);
  return {
    ...readiness,
    alive: true,
    lastLedger: database.lastLedger,
    headLedger: h.headLedger,
    lag: h.lag,
    lastSuccessLedger: h.lastSuccessLedger,
    lastError: h.lastError,
    lastErrorTime: h.lastErrorTime,
    consecutiveErrors: h.consecutiveErrors,
    fetchAttempts: h.fetchAttempts,
    fetchFailures: h.fetchFailures,
  };
}
