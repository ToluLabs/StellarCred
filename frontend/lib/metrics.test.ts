// @vitest-environment node
/// <reference types="vitest/globals" />
/**
 * metrics.test.ts — Unit tests for the Prometheus metrics module.
 *
 * Validates:
 *   - recordIssuance increments the right counters and histograms
 *   - recordRateLimitHit and recordError increment their counters
 *   - renderMetrics produces valid Prometheus text format with correct labels
 *   - All counters default to sensible values (no negative, no NaN)
 */

import {
  recordIssuance,
  recordRateLimitHit,
  recordError,
  renderMetrics,
  resetMetrics,
} from "./metrics";

beforeEach(() => {
  resetMetrics();
});

// ---------------------------------------------------------------------------
// recordIssuance
// ---------------------------------------------------------------------------

describe("recordIssuance", () => {
  it("creates a counter entry for a successful issuance", () => {
    recordIssuance("kyc", "success", 120);
    const output = renderMetrics();
    expect(output).toContain('sc_issuance_requests_total{type="kyc",outcome="success"} 1');
  });

  it("increments the counter on repeated calls", () => {
    recordIssuance("kyc", "success", 80);
    recordIssuance("kyc", "success", 90);
    recordIssuance("kyc", "success", 110);
    const output = renderMetrics();
    expect(output).toContain('sc_issuance_requests_total{type="kyc",outcome="success"} 3');
  });

  it("tracks multiple credential types independently", () => {
    recordIssuance("kyc", "success", 100);
    recordIssuance("age", "success", 200);
    recordIssuance("income", "failure", 50);
    const output = renderMetrics();
    expect(output).toContain('sc_issuance_requests_total{type="kyc",outcome="success"} 1');
    expect(output).toContain('sc_issuance_requests_total{type="age",outcome="success"} 1');
    expect(output).toContain('sc_issuance_requests_total{type="income",outcome="failure"} 1');
  });

  it("emits histogram bucket lines for an observed latency", () => {
    recordIssuance("kyc", "success", 250); // 250ms = 0.25s
    const output = renderMetrics();
    // Should have _bucket, _sum, _count lines
    expect(output).toContain('sc_issuance_latency_seconds_bucket{type="kyc",outcome="success"');
    expect(output).toContain('sc_issuance_latency_seconds_sum{type="kyc",outcome="success"}');
    expect(output).toContain('sc_issuance_latency_seconds_count{type="kyc",outcome="success"} 1');
  });

  it("places observation in the correct histogram bucket", () => {
    // 0.25s falls into the 0.25 bucket (≤ 0.25) but NOT the 0.1 bucket.
    recordIssuance("kyc", "success", 250); // 0.25s exactly
    const output = renderMetrics();
    expect(output).toContain('le="0.25"} 1');
    expect(output).toContain('le="0.1"} 0');
  });

  it("accumulates histogram sum correctly", () => {
    recordIssuance("kyc", "success", 100);   // 0.1s
    recordIssuance("kyc", "success", 200);   // 0.2s
    const output = renderMetrics();
    // Sum should be 0.3 (approximately)
    const match = output.match(/sc_issuance_latency_seconds_sum\{type="kyc",outcome="success"\} ([0-9.]+)/);
    expect(match).not.toBeNull();
    const sum = parseFloat(match![1]);
    expect(sum).toBeCloseTo(0.3, 4);
  });
});

// ---------------------------------------------------------------------------
// recordRateLimitHit
// ---------------------------------------------------------------------------

describe("recordRateLimitHit", () => {
  it("creates a counter for an IP rate-limit hit", () => {
    recordRateLimitHit("issue", "ip");
    const output = renderMetrics();
    expect(output).toContain('sc_rate_limit_hits_total{route="issue",dimension="ip"} 1');
  });

  it("tracks wallet and ip dimensions separately", () => {
    recordRateLimitHit("issue", "ip");
    recordRateLimitHit("issue", "ip");
    recordRateLimitHit("issue", "wallet");
    const output = renderMetrics();
    expect(output).toContain('sc_rate_limit_hits_total{route="issue",dimension="ip"} 2');
    expect(output).toContain('sc_rate_limit_hits_total{route="issue",dimension="wallet"} 1');
  });

  it("tracks different routes independently", () => {
    recordRateLimitHit("issue", "ip");
    recordRateLimitHit("issue_batch", "ip");
    const output = renderMetrics();
    expect(output).toContain('sc_rate_limit_hits_total{route="issue",dimension="ip"} 1');
    expect(output).toContain('sc_rate_limit_hits_total{route="issue_batch",dimension="ip"} 1');
  });
});

// ---------------------------------------------------------------------------
// recordError
// ---------------------------------------------------------------------------

describe("recordError", () => {
  it("creates a counter for a signing error", () => {
    recordError("issue", "signing_error");
    const output = renderMetrics();
    expect(output).toContain('sc_errors_total{route="issue",kind="signing_error"} 1');
  });

  it("increments independently for different kinds", () => {
    recordError("issue", "signing_error");
    recordError("issue", "provider_error");
    recordError("issue_batch", "validation_error");
    const output = renderMetrics();
    expect(output).toContain('sc_errors_total{route="issue",kind="signing_error"} 1');
    expect(output).toContain('sc_errors_total{route="issue",kind="provider_error"} 1');
    expect(output).toContain('sc_errors_total{route="issue_batch",kind="validation_error"} 1');
  });
});

// ---------------------------------------------------------------------------
// renderMetrics — Prometheus text format validation
// ---------------------------------------------------------------------------

describe("renderMetrics", () => {
  it("always includes sc_process_uptime_seconds", () => {
    const output = renderMetrics();
    expect(output).toContain("# HELP sc_process_uptime_seconds");
    expect(output).toContain("# TYPE sc_process_uptime_seconds gauge");
    expect(output).toMatch(/sc_process_uptime_seconds \d+\.\d+/);
  });

  it("always includes HELP and TYPE headers for each metric family", () => {
    const output = renderMetrics();
    const families = [
      "sc_issuance_requests_total",
      "sc_issuance_latency_seconds",
      "sc_rate_limit_hits_total",
      "sc_errors_total",
    ];
    for (const family of families) {
      expect(output).toContain(`# HELP ${family}`);
      expect(output).toContain(`# TYPE ${family}`);
    }
  });

  it("ends with a trailing newline (Prometheus spec requirement)", () => {
    const output = renderMetrics();
    expect(output.endsWith("\n")).toBe(true);
  });

  it("contains no NaN values", () => {
    recordIssuance("kyc", "success", 100);
    recordRateLimitHit("issue", "ip");
    const output = renderMetrics();
    expect(output).not.toContain("NaN");
  });

  it("contains no negative values in counters", () => {
    recordIssuance("kyc", "failure", 50);
    const output = renderMetrics();
    // All numeric values on metric lines should be non-negative
    const metricLines = output
      .split("\n")
      .filter((l) => !l.startsWith("#") && l.trim() !== "");
    for (const line of metricLines) {
      const parts = line.split(" ");
      const value = parseFloat(parts[parts.length - 1]);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("resetMetrics clears all state", () => {
    recordIssuance("kyc", "success", 100);
    recordRateLimitHit("issue", "ip");
    resetMetrics();
    const output = renderMetrics();
    // After reset: no counter lines (only HELP/TYPE/uptime)
    expect(output).not.toContain("sc_issuance_requests_total{");
    expect(output).not.toContain("sc_rate_limit_hits_total{");
    expect(output).not.toContain("sc_errors_total{");
  });
});
