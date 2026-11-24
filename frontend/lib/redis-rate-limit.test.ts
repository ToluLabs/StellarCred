// @vitest-environment node
/// <reference types="vitest/globals" />
/**
 * redis-rate-limit.test.ts — Integration tests for the Redis-backed rate limiter.
 *
 * ## Test strategy
 *
 * Two test paths are covered:
 *
 *  1. **In-process fallback** (always runs) — verifies that when Redis is
 *     unavailable (REDIS_URL unset), `checkLimitRedis` delegates to the
 *     in-process store from rate-limit.ts and behaves identically to
 *     `checkLimit`.
 *
 *  2. **Redis path** (skipped when REDIS_URL is not set) — verifies the
 *     exceed-and-reset lifecycle against a real Redis server (used in CI via
 *     the `redis` service container, or locally via docker-compose.redis.yml).
 *
 * Run locally with Redis:
 *   docker compose -f docker-compose.redis.yml up -d
 *   REDIS_URL=redis://localhost:6379 pnpm test redis-rate-limit
 *
 * Run without Redis (fallback path only):
 *   pnpm test redis-rate-limit
 */

import { checkLimitRedis, closeRedisConnection, isRedisConnected } from "./redis-rate-limit";
import { rateLimitClear } from "./rate-limit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique key per test so tests do not bleed into each other. */
function uniqueKey(label: string): string {
  return `test:${label}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Always-on: in-process fallback behaviour (no Redis required)
// ---------------------------------------------------------------------------

describe("checkLimitRedis — in-process fallback (no REDIS_URL)", () => {
  // Make sure REDIS_URL is absent for these tests.
  const originalRedisUrl = process.env["REDIS_URL"];

  beforeAll(() => {
    delete process.env["REDIS_URL"];
  });

  afterAll(() => {
    if (originalRedisUrl !== undefined) {
      process.env["REDIS_URL"] = originalRedisUrl;
    }
    rateLimitClear();
  });

  beforeEach(() => {
    rateLimitClear();
  });

  it("allows requests under the limit", async () => {
    const key = uniqueKey("fallback-allow");
    const result = await checkLimitRedis(key, 5, 60_000);
    expect(result.throttled).toBe(false);
  });

  it("reports remaining count correctly", async () => {
    const key = uniqueKey("fallback-remaining");
    const limit = 3;

    const first = await checkLimitRedis(key, limit, 60_000);
    expect(first.throttled).toBe(false);
    if (!first.throttled) expect(first.remaining).toBe(2);

    const second = await checkLimitRedis(key, limit, 60_000);
    expect(second.throttled).toBe(false);
    if (!second.throttled) expect(second.remaining).toBe(1);
  });

  it("throttles after limit is exceeded and returns retryAfterMs > 0", async () => {
    const key = uniqueKey("fallback-throttle");
    const limit = 2;

    await checkLimitRedis(key, limit, 60_000);
    await checkLimitRedis(key, limit, 60_000);

    const throttled = await checkLimitRedis(key, limit, 60_000);
    expect(throttled.throttled).toBe(true);
    if (throttled.throttled) {
      expect(throttled.retryAfterMs).toBeGreaterThan(0);
      expect(throttled.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it("uses separate buckets for different keys", async () => {
    const keyA = uniqueKey("fallback-separate-a");
    const keyB = uniqueKey("fallback-separate-b");
    const limit = 1;

    const a = await checkLimitRedis(keyA, limit, 60_000);
    const b = await checkLimitRedis(keyB, limit, 60_000);

    expect(a.throttled).toBe(false);
    expect(b.throttled).toBe(false);
  });

  it("resets after the window expires", async () => {
    const key = uniqueKey("fallback-reset");
    const windowMs = 50; // very short window for test speed
    const limit = 1;

    // Exceed the limit.
    await checkLimitRedis(key, limit, windowMs);
    const throttled = await checkLimitRedis(key, limit, windowMs);
    expect(throttled.throttled).toBe(true);

    // Wait for the window to expire.
    await new Promise((r) => setTimeout(r, windowMs + 20));

    const reset = await checkLimitRedis(key, limit, windowMs);
    expect(reset.throttled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redis path: exceed-and-reset lifecycle
// ---------------------------------------------------------------------------

const REDIS_URL = process.env["REDIS_URL"];
const describeWithRedis = REDIS_URL ? describe : describe.skip;

describeWithRedis("checkLimitRedis — Redis backend (REDIS_URL set)", () => {
  afterAll(async () => {
    await closeRedisConnection();
  });

  it("connects to Redis successfully", async () => {
    // Trigger a connection by running a check — the lazy connect happens here.
    const key = uniqueKey("redis-connect");
    await checkLimitRedis(key, 100, 60_000);
    expect(isRedisConnected()).toBe(true);
  });

  it("allows requests under the limit", async () => {
    const key = uniqueKey("redis-allow");
    const result = await checkLimitRedis(key, 5, 60_000);
    expect(result.throttled).toBe(false);
  });

  it("reports remaining count via Redis INCR", async () => {
    const key = uniqueKey("redis-remaining");
    const limit = 3;

    const first = await checkLimitRedis(key, limit, 60_000);
    expect(first.throttled).toBe(false);
    if (!first.throttled) expect(first.remaining).toBe(2);

    const second = await checkLimitRedis(key, limit, 60_000);
    expect(second.throttled).toBe(false);
    if (!second.throttled) expect(second.remaining).toBe(1);
  });

  it("throttles after limit is exceeded and returns retryAfterMs > 0", async () => {
    const key = uniqueKey("redis-throttle");
    const limit = 2;

    await checkLimitRedis(key, limit, 60_000);
    await checkLimitRedis(key, limit, 60_000);

    const throttled = await checkLimitRedis(key, limit, 60_000);
    expect(throttled.throttled).toBe(true);
    if (throttled.throttled) {
      expect(throttled.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("key expires in Redis after the window (simulate reset)", async () => {
    const key = uniqueKey("redis-reset");
    const windowMs = 200; // short window
    const limit = 1;

    // Exhaust the limit.
    await checkLimitRedis(key, limit, windowMs);
    const overLimit = await checkLimitRedis(key, limit, windowMs);
    expect(overLimit.throttled).toBe(true);

    // Wait for Redis TTL to expire.
    await new Promise((r) => setTimeout(r, windowMs + 100));

    // New window: should be allowed again.
    const afterReset = await checkLimitRedis(key, limit, windowMs);
    expect(afterReset.throttled).toBe(false);
  });

  it("enforces limits independently across separate keys", async () => {
    const keyA = uniqueKey("redis-sep-a");
    const keyB = uniqueKey("redis-sep-b");
    const limit = 1;

    // Exhaust keyA.
    await checkLimitRedis(keyA, limit, 60_000);
    const aThrottled = await checkLimitRedis(keyA, limit, 60_000);
    expect(aThrottled.throttled).toBe(true);

    // keyB is independent — still allowed.
    const bOk = await checkLimitRedis(keyB, limit, 60_000);
    expect(bOk.throttled).toBe(false);
  });
});
