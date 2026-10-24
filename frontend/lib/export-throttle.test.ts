// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore, setSharedStoreForTesting } from "./shared-store";
import {
  checkExportThrottle,
  getExportThrottleStatus,
  __resetExportThrottleForTesting,
} from "./export-throttle";

const ORIGINAL_LIMIT = process.env.EXPORT_RATE_LIMIT_PER_TENANT;
const ORIGINAL_WINDOW = process.env.EXPORT_RATE_LIMIT_WINDOW_SECONDS;

beforeEach(() => {
  setSharedStoreForTesting(new MemoryStore());
  __resetExportThrottleForTesting();
  delete process.env.EXPORT_RATE_LIMIT_PER_TENANT;
  delete process.env.EXPORT_RATE_LIMIT_WINDOW_SECONDS;
});

afterEach(() => {
  setSharedStoreForTesting(null);
  __resetExportThrottleForTesting();
  if (ORIGINAL_LIMIT === undefined) delete process.env.EXPORT_RATE_LIMIT_PER_TENANT;
  else process.env.EXPORT_RATE_LIMIT_PER_TENANT = ORIGINAL_LIMIT;
  if (ORIGINAL_WINDOW === undefined) delete process.env.EXPORT_RATE_LIMIT_WINDOW_SECONDS;
  else process.env.EXPORT_RATE_LIMIT_WINDOW_SECONDS = ORIGINAL_WINDOW;
});

describe("checkExportThrottle", () => {
  it("allows the first call for an issuer (allowed: true)", async () => {
    const result = await checkExportThrottle("issuer-A");
    expect(result.allowed).toBe(true);
    // remaining should be limit - 1 = 9 with default limit of 10
    expect(result.remaining).toBe(9);
  });

  it("blocks the (limit+1)th call for an issuer (allowed: false)", async () => {
    const limit = 10;
    // Exhaust exactly `limit` calls
    for (let i = 0; i < limit; i++) {
      await checkExportThrottle("issuer-B");
    }
    const result = await checkExportThrottle("issuer-B");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("blocks even further calls after limit is reached", async () => {
    const limit = 10;
    for (let i = 0; i < limit + 3; i++) {
      await checkExportThrottle("issuer-C");
    }
    const result = await checkExportThrottle("issuer-C");
    expect(result.allowed).toBe(false);
  });

  it("different issuers have independent counters", async () => {
    const limit = 10;
    // Exhaust issuer D
    for (let i = 0; i < limit + 1; i++) {
      await checkExportThrottle("issuer-D");
    }
    const resultD = await checkExportThrottle("issuer-D");
    expect(resultD.allowed).toBe(false);

    // issuer E is untouched
    const resultE = await checkExportThrottle("issuer-E");
    expect(resultE.allowed).toBe(true);
  });

  it("respects EXPORT_RATE_LIMIT_PER_TENANT env var", async () => {
    process.env.EXPORT_RATE_LIMIT_PER_TENANT = "3";
    // Reset so the new env var is picked up on fresh buckets
    __resetExportThrottleForTesting();

    // 3 calls should be allowed; 4th should be blocked
    for (let i = 0; i < 3; i++) {
      const r = await checkExportThrottle("issuer-F");
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkExportThrottle("issuer-F");
    expect(blocked.allowed).toBe(false);
  });

  it("resetAt is a future timestamp when throttle is active", async () => {
    const before = Date.now();
    const limit = 10;
    for (let i = 0; i < limit + 1; i++) {
      await checkExportThrottle("issuer-G");
    }
    const result = await checkExportThrottle("issuer-G");
    expect(result.allowed).toBe(false);
    expect(result.resetAt).toBeGreaterThan(before);
  });

  it("__resetExportThrottleForTesting clears state — first call allowed again", async () => {
    const limit = 10;
    for (let i = 0; i < limit + 1; i++) {
      await checkExportThrottle("issuer-H");
    }
    const blocked = await checkExportThrottle("issuer-H");
    expect(blocked.allowed).toBe(false);

    // Reset
    setSharedStoreForTesting(new MemoryStore());
    __resetExportThrottleForTesting();

    const allowed = await checkExportThrottle("issuer-H");
    expect(allowed.allowed).toBe(true);
  });
});

describe("getExportThrottleStatus (read-only)", () => {
  it("does not increment the rate-limit counter", async () => {
    // Make one real call to establish a bucket
    await checkExportThrottle("issuer-I");

    // Multiple status reads should NOT change the remaining count
    const s1 = await getExportThrottleStatus("issuer-I");
    const s2 = await getExportThrottleStatus("issuer-I");
    const s3 = await getExportThrottleStatus("issuer-I");

    expect(s1.remaining).toBe(s2.remaining);
    expect(s2.remaining).toBe(s3.remaining);
    // Only 1 call was recorded, so remaining should still be 9 (limit 10 - 1 used)
    expect(s1.remaining).toBe(9);
  });

  it("returns allowed:true when issuer is under limit", async () => {
    const status = await getExportThrottleStatus("issuer-J");
    expect(status.allowed).toBe(true);
    expect(status.issuer).toBe("issuer-J");
  });

  it("returns allowed:false when issuer is over limit", async () => {
    const limit = 10;
    for (let i = 0; i < limit + 1; i++) {
      await checkExportThrottle("issuer-K");
    }
    const status = await getExportThrottleStatus("issuer-K");
    expect(status.allowed).toBe(false);
    expect(status.remaining).toBe(0);
  });
});
