/**
 * health.ts — Health payload for the indexer worker.
 *
 * Gives deployment and monitoring tooling (Docker HEALTHCHECK, Kubernetes
 * probes, load-balancer checks) one well-defined shape to poll, derived from
 * the ingester's health snapshot, database cursor, and ledger lag relative to
 * the trusted network head.
 *
 * Status semantics:
 *   "ok"       — no consecutive fetch errors, and lag is below the warning threshold.
 *   "degraded" — a fetch failed (fewer than ERROR_THRESHOLD), or lag is at/above
 *                warnLedgerLag but below maxLedgerLag.
 *   "error"    — ERROR_THRESHOLD or more consecutive failures, or lag is at/above
 *                maxLedgerLag; the ingester is stalled and data is stale.
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

/** Default ledger lag threshold at or above which status becomes "degraded". */
export const DEFAULT_WARN_LEDGER_LAG = 30;

/** Default ledger lag threshold at or above which status becomes "error" and ready is false. */
export const DEFAULT_MAX_LEDGER_LAG = 120;

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

export interface HealthThresholds {
  errorThreshold?: number;
  warnLedgerLag?: number;
  maxLedgerLag?: number;
}

export interface HealthOptions {
  thresholds?: HealthThresholds;
  now?: Date;
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
  maxLedgerLag: number;
  warnLedgerLag: number;
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

export function statusFromHealth(
  h: Pick<IngesterHealth, "consecutiveErrors"> & Partial<Pick<IngesterHealth, "lag">>,
  thresholds?: HealthThresholds
): HealthStatus {
  const errorThreshold = thresholds?.errorThreshold ?? ERROR_THRESHOLD;
  const maxLag = thresholds?.maxLedgerLag ?? DEFAULT_MAX_LEDGER_LAG;
  const warnLag = thresholds?.warnLedgerLag ?? DEFAULT_WARN_LEDGER_LAG;

  if (h.consecutiveErrors >= errorThreshold) return "error";
  if (typeof h.lag === "number" && h.lag >= 0 && h.lag >= maxLag) return "error";
  if (h.consecutiveErrors > 0) return "degraded";
  if (typeof h.lag === "number" && h.lag >= 0 && h.lag >= warnLag) return "degraded";
  return "ok";
}

export function buildHealthResponse(
  lastLedger: number,
  h: IngesterHealth,
  optionsOrNow?: HealthOptions | HealthThresholds | Date,
  thresholdsArg?: HealthThresholds
): IndexerHealthResponse {
  let now: Date = new Date();
  let thresholds: HealthThresholds | undefined = thresholdsArg;

  if (optionsOrNow instanceof Date) {
    now = optionsOrNow;
  } else if (optionsOrNow && typeof optionsOrNow === "object") {
    if ("now" in optionsOrNow && optionsOrNow.now instanceof Date) {
      now = optionsOrNow.now;
    }
    if ("thresholds" in optionsOrNow && optionsOrNow.thresholds) {
      thresholds = optionsOrNow.thresholds;
    } else if (
      "maxLedgerLag" in optionsOrNow ||
      "warnLedgerLag" in optionsOrNow ||
      "errorThreshold" in optionsOrNow
    ) {
      thresholds = optionsOrNow as HealthThresholds;
    }
  }

  const effectiveThresholds: HealthThresholds = {
    errorThreshold: thresholds?.errorThreshold ?? ERROR_THRESHOLD,
    maxLedgerLag: thresholds?.maxLedgerLag ?? DEFAULT_MAX_LEDGER_LAG,
    warnLedgerLag: thresholds?.warnLedgerLag ?? DEFAULT_WARN_LEDGER_LAG,
  };

  const status = statusFromHealth(h, effectiveThresholds);
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
    maxLedgerLag: effectiveThresholds.maxLedgerLag!,
    warnLedgerLag: effectiveThresholds.warnLedgerLag!,
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
