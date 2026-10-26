/**
 * GET /api/metrics
 *
 * Prometheus-compatible metrics endpoint for the StellarCred frontend.
 *
 * ## Scrape target configuration
 *
 * Add this to your `prometheus.yml` scrape_configs:
 *
 * ```yaml
 * scrape_configs:
 *   - job_name: stellarcred_frontend
 *     scrape_interval: 15s
 *     static_configs:
 *       - targets: ["<your-deployment-host>"]
 *     metrics_path: /api/metrics
 *     # If you gate the endpoint with METRICS_TOKEN (see below):
 *     authorization:
 *       type: Bearer
 *       credentials: <your-token>
 * ```
 *
 * ## Security
 *
 * The endpoint is public by default — it exposes only aggregate counters and
 * latency histograms, no per-request PII or credential content.
 *
 * To gate scraping behind a static token, set `METRICS_TOKEN` in your
 * deployment environment. When set, requests must supply the token as either:
 *   - `Authorization: Bearer <token>`   (standard Prometheus remote_write/http_sd)
 *   - `X-Metrics-Token: <token>`        (simpler reverse-proxy config)
 *
 * Requests without a valid token receive `401 Unauthorized`.
 *
 * ## Metrics exposed
 *
 * See `frontend/lib/metrics.ts` for the full list of metric names, types,
 * labels, and semantics.
 */

import { NextRequest, NextResponse } from "next/server";
import { renderMetrics } from "@/lib/metrics";
import { env } from "@/lib/env";

// Cache-Control: no-store so reverse proxies / CDNs never cache stale metrics.
const RESPONSE_HEADERS = {
  "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── Optional token gate ──────────────────────────────────────────────────
  const requiredToken = env.METRICS_TOKEN;
  if (requiredToken) {
    const authHeader = req.headers.get("authorization") ?? "";
    const tokenHeader = req.headers.get("x-metrics-token") ?? "";

    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";

    if (bearerToken !== requiredToken && tokenHeader !== requiredToken) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  const body = renderMetrics();
  return new NextResponse(body, { status: 200, headers: RESPONSE_HEADERS });
}
