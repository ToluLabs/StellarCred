/**
 * metrics.ts — In-process Prometheus-compatible metrics for the issuance API.
 *
 * ## Design
 *
 * This module maintains a small set of counters and histograms as plain
 * JavaScript numbers/arrays in process memory. There is no external library
 * dependency — the Prometheus text exposition format is straightforward enough
 * to emit directly, matching the approach already used by the indexer service.
 *
 * Metrics are exposed at `GET /api/metrics` (see app/api/metrics/route.ts).
 * That endpoint serialises the current state of this module into the
 * Prometheus text format that Prometheus, Grafana Agent, and most
 * observability stacks can scrape without additional configuration.
 *
 * ## Metrics
 *
 * | Metric name                          | Type      | Labels                    |
 * |--------------------------------------|-----------|---------------------------|
 * | sc_issuance_requests_total           | counter   | type, outcome             |
 * | sc_issuance_latency_seconds          | histogram | type, outcome             |
 * | sc_rate_limit_hits_total             | counter   | route, dimension          |
 * | sc_errors_total                      | counter   | route, kind               |
 * | sc_process_uptime_seconds            | gauge     | —                         |
 *
 * ### Label values
 *
 * - **type**: credential type (kyc, age, income, jurisdiction, funds, accreditation,
 *   employment, batch) or "unknown".
 * - **outcome**: "success" | "failure" | "rate_limited" | "invalid_request"
 * - **route**: "issue" | "issue_batch" | "witness" | "other"
 * - **dimension**: "ip" | "wallet" | "api_key"
 * - **kind**: "signing_error" | "provider_error" | "validation_error" | "unknown"
 *
 * ## Multi-instance note
 *
 * These counters live in process memory. On single-instance deployments (Docker
 * single replica, Railway, Render) this is perfectly accurate.
 *
 * On multi-instance deployments, each instance exposes its own counters
 * independently. A Prometheus scrape job configured with `honor_labels: false`
 * and a distinct `instance` label will aggregate correctly across instances.
 * Alternatively, configure Prometheus federation or push-gateway for global
 * aggregation. This is standard Prometheus multi-instance practice.
 */

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const START_TIME_MS = Date.now();

// Counters stored as nested plain objects: label1 → label2 → count.
// We use string keys formatted as `label=value` pairs for simplicity.

/** issuance requests, keyed by `type|outcome` */
const issuanceRequestsTotal = new Map<string, number>();

/**
 * Latency histogram buckets (seconds). These match the standard Prometheus
 * default buckets, suitable for web API latencies.
 */
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface HistogramState {
  buckets: Map<number, number>; // upper_bound → cumulative count
  sum: number;
  count: number;
}

function newHistogram(): HistogramState {
  return {
    buckets: new Map(LATENCY_BUCKETS.map((b) => [b, 0])),
    sum: 0,
    count: 0,
  };
}

/** issuance latency histograms, keyed by `type|outcome` */
const issuanceLatency = new Map<string, HistogramState>();

/** rate limit hits, keyed by `route|dimension` */
const rateLimitHitsTotal = new Map<string, number>();

/** errors, keyed by `route|kind` */
const errorsTotal = new Map<string, number>();

// ---------------------------------------------------------------------------
// Increment helpers
// ---------------------------------------------------------------------------

function incrementCounter(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function observeHistogram(
  map: Map<string, HistogramState>,
  key: string,
  valueSeconds: number,
): void {
  if (!map.has(key)) map.set(key, newHistogram());
  const h = map.get(key)!;
  for (const bound of LATENCY_BUCKETS) {
    if (valueSeconds <= bound) {
      h.buckets.set(bound, (h.buckets.get(bound) ?? 0) + 1);
    }
  }
  h.sum += valueSeconds;
  h.count += 1;
}

// ---------------------------------------------------------------------------
// Public recording API
// ---------------------------------------------------------------------------

/**
 * Record one completed issuance request.
 *
 * @param credentialType - The type being issued (e.g. "kyc"). Pass "batch"
 *   for batch issuance requests; "unknown" when the type is not yet parsed.
 * @param outcome - Request outcome.
 * @param durationMs - Wall-clock time from request received to response sent.
 */
export function recordIssuance(
  credentialType: string,
  outcome: "success" | "failure" | "rate_limited" | "invalid_request",
  durationMs: number,
): void {
  const key = `${credentialType}|${outcome}`;
  incrementCounter(issuanceRequestsTotal, key);
  observeHistogram(issuanceLatency, key, durationMs / 1000);
}

/**
 * Record one rate-limit hit (a 429 response was sent).
 *
 * @param route  - The API route that was throttled.
 * @param dimension - What the limit was applied against.
 */
export function recordRateLimitHit(
  route: "issue" | "issue_batch" | "witness" | "other",
  dimension: "ip" | "wallet" | "api_key",
): void {
  incrementCounter(rateLimitHitsTotal, `${route}|${dimension}`);
}

/**
 * Record one internal error (5xx outcome).
 */
export function recordError(
  route: "issue" | "issue_batch" | "witness" | "other",
  kind: "signing_error" | "provider_error" | "validation_error" | "unknown",
): void {
  incrementCounter(errorsTotal, `${route}|${kind}`);
}

// ---------------------------------------------------------------------------
// Prometheus text exposition
// ---------------------------------------------------------------------------

/**
 * Render all current metrics as a Prometheus text exposition string.
 * Call this from `GET /api/metrics` to serve the scrape endpoint.
 */
export function renderMetrics(): string {
  const lines: string[] = [];

  // ── sc_process_uptime_seconds ────────────────────────────────────────────
  const uptimeSeconds = (Date.now() - START_TIME_MS) / 1000;
  lines.push("# HELP sc_process_uptime_seconds Seconds since the Next.js process started.");
  lines.push("# TYPE sc_process_uptime_seconds gauge");
  lines.push(`sc_process_uptime_seconds ${uptimeSeconds.toFixed(3)}`);
  lines.push("");

  // ── sc_issuance_requests_total ───────────────────────────────────────────
  lines.push("# HELP sc_issuance_requests_total Total issuance API requests by credential type and outcome.");
  lines.push("# TYPE sc_issuance_requests_total counter");
  for (const [k, v] of issuanceRequestsTotal) {
    const [type, outcome] = k.split("|");
    lines.push(`sc_issuance_requests_total{type="${type}",outcome="${outcome}"} ${v}`);
  }
  lines.push("");

  // ── sc_issuance_latency_seconds ──────────────────────────────────────────
  lines.push("# HELP sc_issuance_latency_seconds Issuance request latency in seconds.");
  lines.push("# TYPE sc_issuance_latency_seconds histogram");
  for (const [k, h] of issuanceLatency) {
    const [type, outcome] = k.split("|");
    const labelBase = `type="${type}",outcome="${outcome}"`;
    for (const [bound, count] of h.buckets) {
      lines.push(`sc_issuance_latency_seconds_bucket{${labelBase},le="${bound}"} ${count}`);
    }
    lines.push(`sc_issuance_latency_seconds_bucket{${labelBase},le="+Inf"} ${h.count}`);
    lines.push(`sc_issuance_latency_seconds_sum{${labelBase}} ${h.sum.toFixed(6)}`);
    lines.push(`sc_issuance_latency_seconds_count{${labelBase}} ${h.count}`);
  }
  lines.push("");

  // ── sc_rate_limit_hits_total ─────────────────────────────────────────────
  lines.push("# HELP sc_rate_limit_hits_total Total requests throttled with a 429 response.");
  lines.push("# TYPE sc_rate_limit_hits_total counter");
  for (const [k, v] of rateLimitHitsTotal) {
    const [route, dimension] = k.split("|");
    lines.push(`sc_rate_limit_hits_total{route="${route}",dimension="${dimension}"} ${v}`);
  }
  lines.push("");

  // ── sc_errors_total ──────────────────────────────────────────────────────
  lines.push("# HELP sc_errors_total Total internal errors by route and kind.");
  lines.push("# TYPE sc_errors_total counter");
  for (const [k, v] of errorsTotal) {
    const [route, kind] = k.split("|");
    lines.push(`sc_errors_total{route="${route}",kind="${kind}"} ${v}`);
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Reset (test helper)
// ---------------------------------------------------------------------------

/** Clear all metrics. Only for use in tests. */
export function resetMetrics(): void {
  issuanceRequestsTotal.clear();
  issuanceLatency.clear();
  rateLimitHitsTotal.clear();
  errorsTotal.clear();
}
