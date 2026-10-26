/**
 * Read-only metrics aggregator for export throttling and scheduling (#788).
 *
 * Aggregates live state from the concurrency counter, the scheduler queue,
 * and (optionally) the per-tenant throttle status into a single
 * `ExportMetrics` object. No side effects — all reads are non-mutating.
 *
 * @module export-metrics
 */

import {
  getActiveConcurrency,
  getMaxConcurrentJobs,
} from "./export-concurrency";
import { listQueuedJobs, type QueueEntry } from "./export-scheduler";
import { getExportThrottleStatus, type ThrottleStatus } from "./export-throttle";

// Re-export ThrottleStatus so callers can import it from this module.
export type { ThrottleStatus } from "./export-throttle";
export type { QueueEntry } from "./export-scheduler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Live metrics snapshot for the export subsystem. */
export interface ExportMetrics {
  /** Number of export slots currently in use. */
  activeJobs: number;
  /** Number of jobs waiting in the cost-aware queue. */
  queueDepth: number;
  /** Full list of queued jobs, sorted by cost ASC. */
  queuedJobs: QueueEntry[];
  /** Maximum allowed simultaneous active export jobs. */
  maxConcurrent: number;
  /**
   * Per-tenant throttle status for `issuer` (read-only — no counter
   * increment). Only present when `issuer` was passed to `getExportMetrics`.
   */
  throttleStatus?: ThrottleStatus;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect a live metrics snapshot for the export subsystem.
 *
 * Reads from `export-concurrency` and `export-scheduler` (always). When
 * `issuer` is provided, also reads the throttle status via
 * `getExportThrottleStatus` — this is a read-only view that does NOT
 * increment the rate-limit counter.
 *
 * @param issuer - Optional DID / issuer address to include throttle info for.
 */
export async function getExportMetrics(issuer?: string): Promise<ExportMetrics> {
  const [activeJobs, queuedJobs] = await Promise.all([
    getActiveConcurrency(),
    listQueuedJobs(),
  ]);

  const maxConcurrent = getMaxConcurrentJobs();

  const metrics: ExportMetrics = {
    activeJobs,
    queueDepth: queuedJobs.length,
    queuedJobs,
    maxConcurrent,
  };

  if (issuer) {
    metrics.throttleStatus = await getExportThrottleStatus(issuer);
  }

  return metrics;
}
