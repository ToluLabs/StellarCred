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

/** Stable service identifier reported in every health response. */
export const SERVICE_NAME = "stellarcred-indexer";

export type HealthStatus = "ok" | "degraded" | "error";

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
