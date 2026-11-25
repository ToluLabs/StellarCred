import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import {
  checkLimit,
  extractIp,
  hashForLog,
  tooManyRequestsResponse,
  rateLimitClear,
  rateLimitSize,
  rateLimitCleanup,
} from "../rate-limit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new Request("http://localhost/api/test", {
    method: "GET",
    headers,
  }) as unknown as NextRequest;
}

// ---------------------------------------------------------------------------
// checkLimit — core counting behaviour
// ---------------------------------------------------------------------------

describe("checkLimit", () => {
  beforeEach(() => rateLimitClear());
  afterEach(() => rateLimitClear());

  it("allows the first request", () => {
    const result = checkLimit("test:key", 3, 60_000);
    expect(result.throttled).toBe(false);
    if (!result.throttled) {
      expect(result.remaining).toBe(2);
    }
  });

  it("counts up to the limit without throttling", () => {
    for (let i = 0; i < 3; i++) {
      expect(checkLimit("test:key", 3, 60_000).throttled).toBe(false);
    }
  });

  it("throttles on the request that exceeds the limit", () => {
    for (let i = 0; i < 3; i++) checkLimit("test:key", 3, 60_000);
    const result = checkLimit("test:key", 3, 60_000);
    expect(result.throttled).toBe(true);
  });

  it("returns a positive retryAfterMs when throttled", () => {
    for (let i = 0; i < 3; i++) checkLimit("test:key", 3, 60_000);
    const result = checkLimit("test:key", 3, 60_000);
    expect(result.throttled).toBe(true);
    if (result.throttled) {
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it("remaining decrements correctly across consecutive allowed requests", () => {
    const r1 = checkLimit("test:rem", 5, 60_000);
    const r2 = checkLimit("test:rem", 5, 60_000);
    const r3 = checkLimit("test:rem", 5, 60_000);
    expect(r1.throttled).toBe(false);
    expect(r2.throttled).toBe(false);
    expect(r3.throttled).toBe(false);
    if (!r1.throttled) expect(r1.remaining).toBe(4);
    if (!r2.throttled) expect(r2.remaining).toBe(3);
    if (!r3.throttled) expect(r3.remaining).toBe(2);
  });

  it("keeps independent counters for different keys", () => {
    for (let i = 0; i < 3; i++) checkLimit("key:a", 3, 60_000);
    expect(checkLimit("key:a", 3, 60_000).throttled).toBe(true);
    expect(checkLimit("key:b", 3, 60_000).throttled).toBe(false);
  });

  it("resets the counter after the window expires", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) checkLimit("test:expire", 3, 1_000);
      expect(checkLimit("test:expire", 3, 1_000).throttled).toBe(true);

      // Advance past the 1-second window.
      vi.advanceTimersByTime(1_001);

      expect(checkLimit("test:expire", 3, 1_000).throttled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a limit of 1 — exactly one request per window", () => {
    expect(checkLimit("test:one", 1, 60_000).throttled).toBe(false);
    expect(checkLimit("test:one", 1, 60_000).throttled).toBe(true);
  });

  it("windowEnd is in the future for allowed requests", () => {
    const before = Date.now();
    const result = checkLimit("test:windowEnd", 5, 60_000);
    expect(result.throttled).toBe(false);
    if (!result.throttled) {
      expect(result.windowEnd).toBeGreaterThan(before);
      expect(result.windowEnd).toBeLessThanOrEqual(before + 60_000 + 10);
    }
  });
});

// ---------------------------------------------------------------------------
// rateLimitCleanup — store compaction
// ---------------------------------------------------------------------------

describe("rateLimitCleanup", () => {
  beforeEach(() => rateLimitClear());
  afterEach(() => rateLimitClear());

  it("removes expired buckets", () => {
    vi.useFakeTimers();
    try {
      checkLimit("cleanup:a", 5, 500);
      checkLimit("cleanup:b", 5, 500);
      expect(rateLimitSize()).toBe(2);

      vi.advanceTimersByTime(600);
      rateLimitCleanup();
      expect(rateLimitSize()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not remove buckets whose window has not yet expired", () => {
    vi.useFakeTimers();
    try {
      checkLimit("active:a", 5, 10_000);
      checkLimit("active:b", 5, 10_000);
      vi.advanceTimersByTime(5_000);
      rateLimitCleanup();
      expect(rateLimitSize()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// extractIp
// ---------------------------------------------------------------------------

describe("extractIp", () => {
  it("returns the first value from x-forwarded-for", () => {
    expect(extractIp(makeRequest({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
  });

  it("handles a single address in x-forwarded-for", () => {
    expect(extractIp(makeRequest({ "x-forwarded-for": "9.10.11.12" }))).toBe("9.10.11.12");
  });

  it("trims whitespace from x-forwarded-for entries", () => {
    expect(extractIp(makeRequest({ "x-forwarded-for": "  1.2.3.4  , 5.6.7.8" }))).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(extractIp(makeRequest({ "x-real-ip": "4.4.4.4" }))).toBe("4.4.4.4");
  });

  it("falls back to cf-connecting-ip when other headers are absent", () => {
    expect(extractIp(makeRequest({ "cf-connecting-ip": "1.1.1.1" }))).toBe("1.1.1.1");
  });

  it("prefers x-forwarded-for over x-real-ip", () => {
    expect(extractIp(makeRequest({ "x-forwarded-for": "10.0.0.1", "x-real-ip": "10.0.0.2" }))).toBe(
      "10.0.0.1",
    );
  });

  it("returns 'unknown' when no IP header is present", () => {
    expect(extractIp(makeRequest())).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// hashForLog — PII safety
// ---------------------------------------------------------------------------

describe("hashForLog", () => {
  it("returns an 8-character hex string", () => {
    const token = hashForLog("192.168.1.1");
    expect(token).toHaveLength(8);
    expect(token).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic for the same input", () => {
    expect(hashForLog("192.168.1.1")).toBe(hashForLog("192.168.1.1"));
  });

  it("produces different tokens for different inputs", () => {
    expect(hashForLog("192.168.1.1")).not.toBe(hashForLog("192.168.1.2"));
  });

  it("does not include the raw input in the token", () => {
    const ip = "203.0.113.42";
    expect(hashForLog(ip)).not.toContain(ip);
  });

  it("does not include a wallet address in the token", () => {
    const wallet = "GABC1234STELLARWALLETADDRESS56789ABCDEFGHIJ";
    expect(hashForLog(wallet)).not.toContain(wallet);
  });
});

// ---------------------------------------------------------------------------
// tooManyRequestsResponse — 429 shape
// ---------------------------------------------------------------------------

describe("tooManyRequestsResponse", () => {
  it("returns status 429", () => {
    const res = tooManyRequestsResponse(5_000);
    expect(res.status).toBe(429);
  });

  it("sets Retry-After to the ceiling of retryAfterMs in seconds", () => {
    const res = tooManyRequestsResponse(5_500);
    expect(res.headers.get("Retry-After")).toBe("6");
  });

  it("sets Retry-After to 1 for sub-second retryAfterMs", () => {
    const res = tooManyRequestsResponse(100);
    expect(res.headers.get("Retry-After")).toBe("1");
  });

  it("sets X-RateLimit-Reset to a Unix epoch timestamp in the future", () => {
    const before = Math.floor(Date.now() / 1000);
    const res = tooManyRequestsResponse(10_000);
    const reset = Number(res.headers.get("X-RateLimit-Reset"));
    expect(reset).toBeGreaterThanOrEqual(before + 10);
  });

  it("includes code: rate_limited in the JSON body", async () => {
    const res = tooManyRequestsResponse(3_000);
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
    expect(typeof body.error).toBe("string");
    expect(body.retryAfterSeconds).toBe(3);
  });

  it("rounds retryAfterMs = 60000 to exactly 60 seconds", () => {
    const res = tooManyRequestsResponse(60_000);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});

// ---------------------------------------------------------------------------
// Integration — full throttle cycle
// ---------------------------------------------------------------------------

describe("rate limit integration", () => {
  beforeEach(() => rateLimitClear());
  afterEach(() => rateLimitClear());

  it("allows exactly `limit` requests then blocks until the window resets", () => {
    vi.useFakeTimers();
    try {
      const limit = 5;
      const windowMs = 2_000;
      const key = "integ:cycle";

      for (let i = 0; i < limit; i++) {
        expect(checkLimit(key, limit, windowMs).throttled).toBe(false);
      }
      expect(checkLimit(key, limit, windowMs).throttled).toBe(true);
      expect(checkLimit(key, limit, windowMs).throttled).toBe(true);

      vi.advanceTimersByTime(windowMs + 1);

      // New window: full allowance restored.
      for (let i = 0; i < limit; i++) {
        expect(checkLimit(key, limit, windowMs).throttled).toBe(false);
      }
      expect(checkLimit(key, limit, windowMs).throttled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("independent keys do not bleed into each other across window boundaries", () => {
    vi.useFakeTimers();
    try {
      // Exhaust key A.
      for (let i = 0; i < 3; i++) checkLimit("key:A", 3, 1_000);
      expect(checkLimit("key:A", 3, 1_000).throttled).toBe(true);

      // Key B is still fresh.
      expect(checkLimit("key:B", 3, 1_000).throttled).toBe(false);

      // Advance past window.
      vi.advanceTimersByTime(1_001);

      // Both keys reset independently.
      expect(checkLimit("key:A", 3, 1_000).throttled).toBe(false);
      expect(checkLimit("key:B", 3, 1_000).throttled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
