import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { configure, hasClaim, invalidate, StellarCred } from "./index";

describe("StellarCred SDK Cache", () => {
  let rpcCallCount = 0;

  beforeEach(() => {
    rpcCallCount = 0;
    invalidate(); // clear cache
    configure({
      cacheEnabled: false,
      cacheTtlMs: 30000,
      readIsVerified: async () => {
        rpcCallCount++;
        return { valid: true, verifiedAt: 1000, expiry: 2000 };
      },
      readCheckClaim: async () => {
        rpcCallCount++;
        return true;
      },
    });
  });

  it("is disabled by default and makes an RPC call on every hasClaim read", async () => {
    const res1 = await hasClaim("G123", "kyc");
    assert.strictEqual(res1, true);
    assert.strictEqual(rpcCallCount, 1);

    const res2 = await hasClaim("G123", "kyc");
    assert.strictEqual(res2, true);
    assert.strictEqual(rpcCallCount, 2);
  });

  it("serves repeated reads within TTL from cache when opt-in enabled (hit & miss)", async () => {
    configure({ cacheEnabled: true, cacheTtlMs: 5000 });

    // Miss: 1st call
    const res1 = await hasClaim("G123", "kyc");
    assert.strictEqual(res1, true);
    assert.strictEqual(rpcCallCount, 1);

    // Hit: 2nd call within TTL
    const res2 = await hasClaim("G123", "kyc");
    assert.strictEqual(res2, true);
    assert.strictEqual(rpcCallCount, 1);

    // Miss: Different claim type
    const res3 = await hasClaim("G123", "age");
    assert.strictEqual(res3, true);
    assert.strictEqual(rpcCallCount, 2);

    // Miss: Different threshold
    const res4 = await hasClaim("G123", "age", { minThreshold: 21 });
    assert.strictEqual(res4, true);
    assert.strictEqual(rpcCallCount, 3);

    // Hit: Same threshold
    const res5 = await hasClaim("G123", "age", { minThreshold: 21 });
    assert.strictEqual(res5, true);
    assert.strictEqual(rpcCallCount, 3);
  });

  it("expires cache entries after TTL", async () => {
    configure({ cacheEnabled: true, cacheTtlMs: 100 });

    const res1 = await hasClaim("G123", "kyc");
    assert.strictEqual(res1, true);
    assert.strictEqual(rpcCallCount, 1);

    // Immediate repeat read (hit)
    const res2 = await hasClaim("G123", "kyc");
    assert.strictEqual(res2, true);
    assert.strictEqual(rpcCallCount, 1);

    // Wait for TTL expiry
    await new Promise((r) => setTimeout(r, 150));

    // Post-expiry read (miss)
    const res3 = await hasClaim("G123", "kyc");
    assert.strictEqual(res3, true);
    assert.strictEqual(rpcCallCount, 2);
  });

  it("clears entries with invalidate(wallet, credentialType)", async () => {
    configure({ cacheEnabled: true, cacheTtlMs: 60000 });

    await hasClaim("G123", "kyc");
    await hasClaim("G123", "age");
    assert.strictEqual(rpcCallCount, 2);

    // Invalidate only kyc for G123
    invalidate("G123", "kyc");

    // kyc should miss
    await hasClaim("G123", "kyc");
    assert.strictEqual(rpcCallCount, 3);

    // age should still hit cache
    await hasClaim("G123", "age");
    assert.strictEqual(rpcCallCount, 3);
  });

  it("clears all wallet entries with invalidate(wallet)", async () => {
    configure({ cacheEnabled: true, cacheTtlMs: 60000 });

    await hasClaim("G123", "kyc");
    await hasClaim("G123", "age");
    await hasClaim("G456", "kyc");
    assert.strictEqual(rpcCallCount, 3);

    // Invalidate all claims for G123
    invalidate("G123");

    // Both G123 claims should miss
    await hasClaim("G123", "kyc");
    assert.strictEqual(rpcCallCount, 4);
    await hasClaim("G123", "age");
    assert.strictEqual(rpcCallCount, 5);

    // G456 claim should still hit cache
    await hasClaim("G456", "kyc");
    assert.strictEqual(rpcCallCount, 5);
  });

  it("clears entire cache with invalidate() without args", async () => {
    configure({ cacheEnabled: true, cacheTtlMs: 60000 });

    await hasClaim("G123", "kyc");
    await hasClaim("G456", "kyc");
    assert.strictEqual(rpcCallCount, 2);

    invalidate();

    await hasClaim("G123", "kyc");
    assert.strictEqual(rpcCallCount, 3);
    await hasClaim("G456", "kyc");
    assert.strictEqual(rpcCallCount, 4);
  });

  it("supports opt-in and TTL configuration via nested cache object or flat options", async () => {
    configure({ cache: { enabled: true, ttlMs: 100 } });

    await hasClaim("G123", "kyc");
    assert.strictEqual(rpcCallCount, 1);

    await hasClaim("G123", "kyc");
    assert.strictEqual(rpcCallCount, 1);

    await new Promise((r) => setTimeout(r, 150));

    await hasClaim("G123", "kyc");
    assert.strictEqual(rpcCallCount, 2);
  });

  it("exposes invalidate on StellarCred export object", () => {
    assert.strictEqual(typeof StellarCred.invalidate, "function");
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isVerified = vi.fn();
const checkClaim = vi.fn();

vi.mock("../../proof-registry/src/index.js", () => ({
  Client: vi.fn(function ProofRegistryClient() {
    return {
      is_verified: isVerified,
      check_claim: checkClaim,
    };
  }),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {},
}));

import {
  configure,
  hasClaim,
  getClaims,
  ConfigError,
  RpcError,
  TimeoutError,
  StellarCred,
  withRetry,
} from "./index";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

describe("error taxonomy exports", () => {
  it("exports ConfigError, RpcError, and TimeoutError on the namespace", () => {
    expect(StellarCred.ConfigError).toBe(ConfigError);
    expect(StellarCred.RpcError).toBe(RpcError);
    expect(StellarCred.TimeoutError).toBe(TimeoutError);
    expect(new ConfigError().name).toBe("ConfigError");
    expect(new RpcError().name).toBe("RpcError");
  });
});

describe("hasClaim — fail-soft default", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({ registryId: "" });
  });

  it("returns false when registryId is missing (no throw)", async () => {
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
    expect(isVerified).not.toHaveBeenCalled();
  });

  it("returns false when is_verified throws (network/simulation)", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue(new Error("network down"));
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("returns false when the holder is not verified", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockResolvedValue({ result: [false, 0n, 0n] });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("returns true when the holder is verified", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockResolvedValue({ result: [true, 1_700_000_000n, 1_800_000_000n] });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
  });

  it("returns false when check_claim throws under fail-soft", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    checkClaim.mockRejectedValue(new Error("rpc timeout"));
    await expect(hasClaim(WALLET, "age", { minThreshold: 21 })).resolves.toBe(false);
  });
});

describe("hasClaim — throwOnError", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
  });

  afterEach(() => {
    configure({ registryId: "C_TEST_REGISTRY" });
  });

  it("throws ConfigError when registryId is missing", async () => {
    configure({ registryId: "" });
    await expect(hasClaim(WALLET, "kyc", { throwOnError: true })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("throws RpcError when is_verified fails, not ConfigError", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue(new Error("connection reset"));
    const err = await hasClaim(WALLET, "kyc", { throwOnError: true }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).not.toBeInstanceOf(ConfigError);
    expect((err as RpcError).cause).toBeInstanceOf(Error);
  });

  it("throws RpcError when check_claim fails", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    checkClaim.mockRejectedValue(new Error("simulation failed"));
    await expect(
      hasClaim(WALLET, "funds", { minThreshold: 50_000, throwOnError: true }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it("still returns false for not-verified (does not throw)", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockResolvedValue({ result: [false, 0n, 0n] });
    await expect(hasClaim(WALLET, "kyc", { throwOnError: true })).resolves.toBe(false);
  });

  it("returns true for verified claims", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockResolvedValue({ result: [true, 10n, 20n] });
    await expect(hasClaim(WALLET, "kyc", { throwOnError: true })).resolves.toBe(true);
  });
});

describe("getClaims — throwOnError", () => {
  beforeEach(() => {
    isVerified.mockReset();
  });

  it("fail-soft returns [] when unconfigured", async () => {
    configure({ registryId: "" });
    await expect(getClaims(WALLET)).resolves.toEqual([]);
  });

  it("throws ConfigError when unconfigured and throwOnError", async () => {
    configure({ registryId: "" });
    await expect(getClaims(WALLET, { throwOnError: true })).rejects.toBeInstanceOf(ConfigError);
  });

  it("throws RpcError when a read fails under throwOnError", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    isVerified.mockRejectedValue(new Error("boom"));
    await expect(getClaims(WALLET, { throwOnError: true })).rejects.toBeInstanceOf(RpcError);
  });
});

describe("SDK withRetry with exponential backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default config for testing
    configure({
      retries: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return immediately if operation succeeds", async () => {
    const operation = vi.fn().mockResolvedValue("success");
    const promise = withRetry(operation);
    const result = await promise;
    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should fail fast if error is non-retryable", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("invalid argument provided"));
    
    await expect(withRetry(operation)).rejects.toThrow("invalid argument provided");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("should retry on transient errors and eventually succeed", async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce("success");

    let error: any;
    const promise = withRetry(operation).catch(e => { error = e; });
    
    // First attempt fails, wait for delay (100ms)
    await vi.advanceTimersByTimeAsync(100);
    // Second attempt fails, wait for delay (200ms)
    await vi.advanceTimersByTimeAsync(200);

    await promise;
    expect(error).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("should throw after max retries are exceeded", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("network error"));

    let error: any;
    const promise = withRetry(operation).catch(e => { error = e; });
    
    // Attempt 1 fails -> wait 100
    await vi.advanceTimersByTimeAsync(100);
    // Attempt 2 fails -> wait 200
    await vi.advanceTimersByTimeAsync(200);
    // Attempt 3 fails -> wait 400
    await vi.advanceTimersByTimeAsync(400);

    await promise;
    expect(error).toBeDefined();
    expect(error.message).toBe("network error");
    expect(operation).toHaveBeenCalledTimes(4); // initial + 3 retries
  });
});
