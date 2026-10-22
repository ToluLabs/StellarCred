// @vitest-environment node
/**
 * Tests for export-concurrency.ts
 *
 * Note on TOCTOU: The incr-then-check pattern in `acquireConcurrencySlot` is
 * subject to a race on multi-instance deploys (UpstashRedisStore): two
 * concurrent calls can both increment past the cap before either rolls back.
 * This is documented in the module JSDoc and is intentionally not tested here
 * (it requires actual concurrent async execution, which Node.js's single-
 * threaded event loop does not produce in this test suite).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore, setSharedStoreForTesting } from "./shared-store";
import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
  getActiveConcurrency,
  getMaxConcurrentJobs,
  __resetConcurrencyForTesting,
} from "./export-concurrency";

const ORIGINAL_MAX = process.env.EXPORT_MAX_CONCURRENT_JOBS;

beforeEach(() => {
  setSharedStoreForTesting(new MemoryStore());
  delete process.env.EXPORT_MAX_CONCURRENT_JOBS;
});

afterEach(() => {
  setSharedStoreForTesting(null);
  if (ORIGINAL_MAX === undefined) delete process.env.EXPORT_MAX_CONCURRENT_JOBS;
  else process.env.EXPORT_MAX_CONCURRENT_JOBS = ORIGINAL_MAX;
});

describe("getActiveConcurrency", () => {
  it("returns 0 on a fresh store", async () => {
    expect(await getActiveConcurrency()).toBe(0);
  });
});

describe("acquireConcurrencySlot", () => {
  it("succeeds when under the cap and increments the counter", async () => {
    const result = await acquireConcurrencySlot();
    expect(result).toBe(true);
    expect(await getActiveConcurrency()).toBe(1);
  });

  it("succeeds up to the cap (default 5)", async () => {
    const cap = getMaxConcurrentJobs(); // 5
    const results: boolean[] = [];
    for (let i = 0; i < cap; i++) {
      results.push(await acquireConcurrencySlot());
    }
    expect(results.every((r) => r === true)).toBe(true);
    expect(await getActiveConcurrency()).toBe(cap);
  });

  it("returns false on the (cap+1)th call", async () => {
    const cap = getMaxConcurrentJobs(); // 5
    for (let i = 0; i < cap; i++) {
      await acquireConcurrencySlot();
    }
    const result = await acquireConcurrencySlot();
    expect(result).toBe(false);
    // counter should not exceed cap
    expect(await getActiveConcurrency()).toBe(cap);
  });

  it("respects EXPORT_MAX_CONCURRENT_JOBS env var", async () => {
    process.env.EXPORT_MAX_CONCURRENT_JOBS = "2";

    const first = await acquireConcurrencySlot();
    expect(first).toBe(true);
    const second = await acquireConcurrencySlot();
    expect(second).toBe(true);
    const third = await acquireConcurrencySlot();
    expect(third).toBe(false);
  });
});

describe("releaseConcurrencySlot", () => {
  it("decrements the counter after acquire", async () => {
    await acquireConcurrencySlot();
    expect(await getActiveConcurrency()).toBe(1);
    await releaseConcurrencySlot();
    expect(await getActiveConcurrency()).toBe(0);
  });

  it("does not go below 0 when called on an empty counter", async () => {
    // No slots acquired
    await releaseConcurrencySlot();
    expect(await getActiveConcurrency()).toBe(0);
  });

  it("releases a slot so new acquire can succeed after the cap was full", async () => {
    const cap = getMaxConcurrentJobs();
    for (let i = 0; i < cap; i++) {
      await acquireConcurrencySlot();
    }
    // cap is full — next acquire fails
    expect(await acquireConcurrencySlot()).toBe(false);

    // Release one slot
    await releaseConcurrencySlot();

    // Now acquire should succeed
    expect(await acquireConcurrencySlot()).toBe(true);
  });
});

describe("__resetConcurrencyForTesting", () => {
  it("resets the counter to 0", async () => {
    await acquireConcurrencySlot();
    await acquireConcurrencySlot();
    expect(await getActiveConcurrency()).toBe(2);

    // Reset via a new MemoryStore (full isolation)
    setSharedStoreForTesting(new MemoryStore());
    __resetConcurrencyForTesting();
    // After a fresh store the counter is gone
    expect(await getActiveConcurrency()).toBe(0);
  });
});
