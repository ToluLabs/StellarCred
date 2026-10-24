// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";
import { logger } from "@/lib/logger";
import { rateLimitClear } from "@/lib/rate-limit";

const IP = "192.0.2.1";

function createReportRequest(
  bodyText: string,
  contentType = "application/csp-report",
  ip = IP,
): NextRequest {
  return new NextRequest("http://localhost/api/csp-report", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      "content-type": contentType,
      "content-length": String(Buffer.byteLength(bodyText)),
    },
    body: bodyText,
  });
}

describe("POST /api/csp-report", () => {
  const originalEnv = process.env.RATE_LIMIT_CSP_REPORT_IP;

  beforeEach(() => {
    rateLimitClear();
    process.env.RATE_LIMIT_CSP_REPORT_IP = "2";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv !== undefined) {
      process.env.RATE_LIMIT_CSP_REPORT_IP = originalEnv;
    } else {
      delete process.env.RATE_LIMIT_CSP_REPORT_IP;
    }
  });

  it("handles legacy payload: returns 204 and logs one sanitized violation via logger.warn", async () => {
    const warnSpy = vi.spyOn(logger, "warn");

    const payload = {
      "csp-report": {
        "document-uri": "https://example.com/holder?token=secret123#view",
        "blocked-uri": "https://evil.com/leak.js?track=456",
        "effective-directive": "script-src",
        "disposition": "enforce",
        "source-file": "https://example.com/bundle.js?v=99",
        "line-number": 12,
        "column-number": 34,
        "status-code": 200,
        "script-sample": "secret_eval_payload()",
        "original-policy": "default-src 'self'",
      },
    };

    const req = createReportRequest(JSON.stringify(payload));
    const res = await POST(req);

    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][0];

    expect(logged).toMatchObject({
      event: "csp_violation",
      cspViolation: {
        documentUri: "https://example.com/holder",
        blockedUri: "https://evil.com/leak.js",
        sourceFile: "https://example.com/bundle.js",
        effectiveDirective: "script-src",
        disposition: "enforce",
        lineNumber: 12,
        columnNumber: 34,
        statusCode: 200,
      },
    });

    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("secret123");
    expect(serialized).not.toContain("secret_eval_payload");
    expect(serialized).not.toContain("?token=");
    expect(serialized).not.toContain("?track=");
    expect(serialized).not.toContain("?v=");
  });

  it("handles application/reports+json array payload: returns 204", async () => {
    const warnSpy = vi.spyOn(logger, "warn");

    const payload = [
      {
        type: "csp-violation",
        url: "https://example.com/verify?code=789",
        body: {
          documentURL: "https://example.com/verify?code=789",
          blockedURL: "inline",
          effectiveDirective: "style-src",
          disposition: "report",
          sourceFile: "https://example.com/style.css",
          lineNumber: 5,
        },
      },
    ];

    const req = createReportRequest(
      JSON.stringify(payload),
      "application/reports+json",
      "192.0.2.2",
    );
    const res = await POST(req);

    expect(res.status).toBe(204);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0][0];

    expect(logged).toMatchObject({
      event: "csp_violation",
      cspViolation: {
        documentUri: "https://example.com/verify",
        blockedUri: "inline",
        sourceFile: "https://example.com/style.css",
        effectiveDirective: "style-src",
        disposition: "report",
        lineNumber: 5,
      },
    });
  });

  it("returns 413 for oversized body", async () => {
    const oversized = JSON.stringify({
      "csp-report": {
        "document-uri": "https://example.com",
        "blocked-uri": "inline",
        padding: "x".repeat(17 * 1024),
      },
    });

    const req = createReportRequest(oversized, "application/csp-report", "192.0.2.3");
    const res = await POST(req);

    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.code).toBe("payload_too_large");
  });

  it("returns 400 for invalid JSON", async () => {
    const invalidJson = "{ this is not valid json";
    const req = createReportRequest(invalidJson, "application/csp-report", "192.0.2.4");
    const res = await POST(req);

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("invalid_json");
  });

  it("returns 429 with Retry-After when exceeding rate limit", async () => {
    const warnSpy = vi.spyOn(logger, "warn");

    const payload = JSON.stringify({
      "csp-report": {
        "document-uri": "https://example.com",
        "blocked-uri": "inline",
        "effective-directive": "script-src",
        "disposition": "report",
      },
    });

    // Request 1: OK
    const res1 = await POST(createReportRequest(payload, "application/csp-report", "192.0.2.5"));
    expect(res1.status).toBe(204);

    // Request 2: OK (limit = 2)
    const res2 = await POST(createReportRequest(payload, "application/csp-report", "192.0.2.5"));
    expect(res2.status).toBe(204);

    // Request 3: Exceeds limit -> 429
    const res3 = await POST(createReportRequest(payload, "application/csp-report", "192.0.2.5"));
    expect(res3.status).toBe(429);
    expect(res3.headers.get("retry-after")).toBeTruthy();

    const rateLimitedLog = warnSpy.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).event === "csp_report_rate_limited",
    );
    expect(rateLimitedLog).toBeDefined();
  });

  it("ensures serialized log output never contains sample text or query strings", async () => {
    const warnSpy = vi.spyOn(logger, "warn");

    const payload = {
      "csp-report": {
        "document-uri": "https://example.com/sensitive-doc?token=mysecretapikey#section",
        "blocked-uri": "https://evil-analytics.org/collect?user_id=12345",
        "source-file": "https://example.com/app.js?debug=true",
        "effective-directive": "script-src",
        "disposition": "report",
        "script-sample": "const password = 'mySuperSecretPassword';",
        sample: "const creditCard = '1234-5678-9012-3456';",
        "original-policy": "default-src 'self'; script-src 'self'",
        referrer: "https://example.com/referrer?auth=yes",
      },
    };

    const req = createReportRequest(JSON.stringify(payload), "application/csp-report", "192.0.2.6");
    const res = await POST(req);
    expect(res.status).toBe(204);

    const logged = warnSpy.mock.calls[0][0];
    const serialized = JSON.stringify(logged);

    expect(serialized).not.toContain("mysecretapikey");
    expect(serialized).not.toContain("user_id");
    expect(serialized).not.toContain("debug=true");
    expect(serialized).not.toContain("mySuperSecretPassword");
    expect(serialized).not.toContain("1234-5678-9012-3456");
    expect(serialized).not.toContain("original-policy");
    expect(serialized).not.toContain("referrer");
    expect(serialized).not.toContain("?");
  });
});
