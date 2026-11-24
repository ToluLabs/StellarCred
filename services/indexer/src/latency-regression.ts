/**
 * latency-regression.ts — the decision rule behind the pgbench latency gate.
 *
 * Kept out of the runner script so it can be unit-tested without a PostgreSQL
 * server: the runner only invokes pgbench and parses its output, then hands the
 * numbers here.
 *
 * The gate is deliberately tolerant. A committed baseline is one measurement on
 * one machine; shared CI runners are noisy and a benchmark that fails on jitter
 * gets ignored or deleted. A run therefore fails only when the observed mean
 * latency exceeds a budget of
 *
 *     max(baseline * toleranceFactor, absoluteFloorMs)
 *
 * — meaningfully slower than the recorded baseline, rather than merely
 * different. Raise the baseline deliberately, in the same PR that changes the
 * query it measures.
 *
 * A baseline that was never actually recorded — our committed default, or any
 * freshly regenerated baseline whose value is still tiny — is one of those
 * placeholders. Rather than fail the run against a made-up number, the gate
 * returns a clear `gate-skipped` condition and lets the report describe the
 * situation; only the first real measurement re-establishes a committed
 * baseline (bump `version` to 2 when you do).
 */

export interface LatencyBaseline {
  /** Schema version of the baseline file. */
  version: number;
  /** Human-readable description of the workload the number came from. */
  workload?: string;
  /** Mean transaction latency, in milliseconds. */
  averageLatencyMs: number;
  /** Transactions per second at the time the baseline was recorded (reported only). */
  tps?: number;
}

export interface LatencyObservation {
  averageLatencyMs: number;
  tps?: number;
}

export interface LatencyGateOptions {
  /** Multiplier applied to the baseline before comparing. */
  toleranceFactor: number;
  /** Minimum allowance, so a very fast baseline cannot fail on noise. */
  absoluteFloorMs: number;
}

export interface LatencyGateResult {
  ok: boolean;
  /** The maximum mean latency this run was allowed; `NaN` when the gate could not be evaluated. */
  budgetMs: number;
  /** One line per failed condition; empty when `ok`. */
  failures: string[];
}

export const DEFAULT_LATENCY_GATE: LatencyGateOptions = {
  toleranceFactor: 2.5,
  absoluteFloorMs: 20,
};

/** Smallest value a baseline is allowed to have if it is meant to be real. */
const MIN_REAL_BASELINE_MS = 0.1;

export function evaluateLatencyGate(
  observed: LatencyObservation,
  baseline: LatencyBaseline,
  options: LatencyGateOptions = DEFAULT_LATENCY_GATE,
): LatencyGateResult {
  const failures: string[] = [];

  if (!Number.isFinite(observed.averageLatencyMs) || observed.averageLatencyMs <= 0) {
    failures.push(
      `pgbench reported an invalid average latency: ${observed.averageLatencyMs}`,
    );
  }
  if (!Number.isFinite(baseline.averageLatencyMs) || baseline.averageLatencyMs <= 0) {
    failures.push(
      `latency baseline is invalid (averageLatencyMs=${baseline.averageLatencyMs})`,
    );
    return { ok: false, budgetMs: Number.NaN, failures };
  }
  if (!Number.isFinite(options.toleranceFactor) || options.toleranceFactor < 1) {
    failures.push(
      `toleranceFactor must be >= 1, got ${options.toleranceFactor}`,
    );
  }
  if (!Number.isFinite(options.absoluteFloorMs) || options.absoluteFloorMs < 0) {
    failures.push(`absoluteFloorMs must be >= 0, got ${options.absoluteFloorMs}`);
  }
  if (failures.length > 0) {
    return { ok: false, budgetMs: Number.NaN, failures };
  }

  // The shipped `baseline.json` is a placeholder, intentionally below the real
  // measurement it will become. To distinguish "never measured" from "measured
  // and re-pinning the baseline", the runner writes `version: 2` when it
  // re-records; the gate treats `version >= 2` as committed and everything else
  // as not-yet-recorded, and skips rather than failing against a placeholder.
  if (baseline.version < 2) {
    failures.push(
      "gate-skipped: no committed baseline recorded yet — run pgbench and update perf/pgbench/baseline.json",
    );
    return { ok: false, budgetMs: Number.NaN, failures };
  }

  const budgetMs = Math.max(
    baseline.averageLatencyMs * options.toleranceFactor,
    options.absoluteFloorMs,
  );

  if (observed.averageLatencyMs > budgetMs) {
    failures.push(
      `average query latency ${observed.averageLatencyMs.toFixed(2)} ms exceeds the ` +
        `${budgetMs.toFixed(2)} ms budget ` +
        `(baseline ${baseline.averageLatencyMs.toFixed(2)} ms × ${options.toleranceFactor}` +
        `, floor ${options.absoluteFloorMs} ms)`,
    );
  }

  return { ok: failures.length === 0, budgetMs, failures };
}
