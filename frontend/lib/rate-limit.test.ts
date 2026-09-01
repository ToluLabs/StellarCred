// @vitest-environment node
//
// Unit tests for the read-only usage view added for the self-serve rate-limit
// dashboard (GitHub #424): getRateLimitStatus must report the same numbers a
// real request would be charged WITHOUT recording anything, so that polling a
// dashboard never consumes quota or mutates the store.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  checkLimit,
  getRateLimitStatus,
  rateLimitClear,
  rateLimitSize,
} from "./rate-limit";

const WINDOW = 60_000;
const LIMIT = 10;

beforeEach(() => {
  rateLimitClear();
});

describe("getRateLimitStatus", () => {
  it("reports an untouched window for a key that was never recorded", () => {
    const s = getRateLimitStatus("issue:ip:1.2.3.4", LIMIT, WINDOW);
    expect(s.used).toBe(0);
    expect(s.limit).toBe(LIMIT);
    expect(s.remaining).toBe(LIMIT);
    expect(s.throttled).toBe(false);
    expect(s.windowMs).toBe(WINDOW);
    expect(s.windowEnd).toBeGreaterThan(Date.now());
    expect(s.resetSeconds).toBeGreaterThan(0);
  });

  it("reflects the count recorded by checkLimit for the same key", () => {
    checkLimit("issue:wallet:G", LIMIT, WINDOW);
    checkLimit("issue:wallet:G", LIMIT, WINDOW);

    const s = getRateLimitStatus("issue:wallet:G", LIMIT, WINDOW);
    expect(s.used).toBe(2);
    expect(s.remaining).toBe(LIMIT - 2);
    expect(s.throttled).toBe(false);
  });

  it("flags an exhausted window as throttled with the remaining reset timing", () => {
    for (let i = 0; i < LIMIT; i++) {
      checkLimit("issue:ip:9.9.9.9", LIMIT, WINDOW);
    }
    const s = getRateLimitStatus("issue:ip:9.9.9.9", LIMIT, WINDOW);
    expect(s.used).toBe(LIMIT);
    expect(s.remaining).toBe(0);
    expect(s.throttled).toBe(true);
    expect(s.windowEnd).toBeGreaterThan(Date.now());
    expect(s.resetSeconds).toBeGreaterThan(0);
  });

  it("is read-only: repeated status reads never alter the store", () => {
    checkLimit("issue:ip:5.5.5.5", LIMIT, WINDOW);
    const sizeBefore = rateLimitSize();

    getRateLimitStatus("issue:ip:5.5.5.5", LIMIT, WINDOW);
    getRateLimitStatus("issue:ip:5.5.5.5", LIMIT, WINDOW);
    getRateLimitStatus("issue:ip:unseen", LIMIT, WINDOW);

    // No new bucket and no count increment from any status read.
    expect(rateLimitSize()).toBe(sizeBefore);
    expect(getRateLimitStatus("issue:ip:5.5.5.5", LIMIT, WINDOW).used).toBe(1);
    // An unseen key is never materialized into the store.
    expect(getRateLimitStatus("issue:ip:unseen", LIMIT, WINDOW).used).toBe(0);
  });

  it("treats an expired window as fresh (used 0) without mutating the store", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      checkLimit("issue:ip:7.7.7.7", 1, 1000); // windowEnd = 1_001_000

      // Advance past the window's end so the bucket is now stale.
      vi.setSystemTime(1_100_000);
      const s = getRateLimitStatus("issue:ip:7.7.7.7", LIMIT, WINDOW);
      expect(s.used).toBe(0);
      expect(s.remaining).toBe(LIMIT);
      expect(s.throttled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});