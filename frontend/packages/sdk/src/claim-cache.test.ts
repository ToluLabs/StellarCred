import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { isVerified, checkClaim } = vi.hoisted(() => ({
  isVerified: vi.fn(),
  checkClaim: vi.fn(),
}));

vi.mock("../../proof-registry/src/index", () => ({
  Client: vi.fn(function ProofRegistryClient() {
    return { is_verified: isVerified, check_claim: checkClaim };
  }),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {},
  StrKey: {
    isValidEd25519PublicKey: vi.fn((address: string) => /^G[A-Z2-7]{10,}$/.test(address)),
  },
}));

import {
  configure,
  resetConfig,
  hasClaim,
  hasClaims,
  getClaim,
  verifyPreset,
  watchClaim,
  invalidateClaimCache,
  clearClaimCache,
  getClaimCacheSize,
  getConfig,
  ConfigError,
  StellarCred,
} from "./index";
import { ClaimCache, claimCacheKey } from "./claim-cache";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const OTHER = "GZYXWVUTSRQPONMLKJIHGFEDCBA765432";
const FAR_FUTURE = 4_000_000_000n; // year 2096
const NO_RETRY = { retries: 0 };

const verified = (expiry: bigint = FAR_FUTURE) => ({
  result: [true, 1_700_000_000n, expiry],
});
const notVerified = () => ({ result: [false, 0n, 0n] });

function enableCache(extra: Parameters<typeof configure>[0] = {}) {
  configure({ registryId: "C_TEST_REGISTRY", claimCache: true, ...extra });
}

beforeEach(() => {
  resetConfig();
  isVerified.mockReset();
  checkClaim.mockReset();
  isVerified.mockResolvedValue(verified());
  checkClaim.mockResolvedValue({ result: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("claim cache — configuration", () => {
  it("is disabled by default, so every read reaches the RPC", async () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    expect(getConfig()).toMatchObject({
      claimCache: false,
      claimCacheTtlMs: 30_000,
      claimCacheMaxEntries: 1000,
    });

    await hasClaim(WALLET, "kyc");
    await hasClaim(WALLET, "kyc");
    expect(isVerified).toHaveBeenCalledTimes(2);
    expect(getClaimCacheSize()).toBe(0);
  });

  it("rejects a non-positive TTL or entry cap", () => {
    expect(() => configure({ claimCacheTtlMs: 0 })).toThrow(ConfigError);
    expect(() => configure({ claimCacheTtlMs: -5 })).toThrow(ConfigError);
    expect(() => configure({ claimCacheTtlMs: Number.NaN })).toThrow(ConfigError);
    expect(() => configure({ claimCacheMaxEntries: 0 })).toThrow(ConfigError);
    expect(() => configure({ claimCacheMaxEntries: 1.5 })).toThrow(ConfigError);
    expect(getConfig().claimCacheTtlMs).toBe(30_000);
  });

  it("can be turned off again, which also empties it", async () => {
    enableCache();
    await hasClaim(WALLET, "kyc");
    expect(getClaimCacheSize()).toBe(1);

    configure({ claimCache: false });
    expect(getClaimCacheSize()).toBe(0);
    await hasClaim(WALLET, "kyc");
    await hasClaim(WALLET, "kyc");
    expect(isVerified).toHaveBeenCalledTimes(3);
  });

  it("is emptied by configure(), since answers may come from another registry", async () => {
    enableCache();
    await hasClaim(WALLET, "kyc");
    configure({ registryId: "C_OTHER_REGISTRY" });
    await hasClaim(WALLET, "kyc");
    expect(isVerified).toHaveBeenCalledTimes(2);
  });
});

describe("claim cache — hits and misses", () => {
  it("serves a repeated read within the TTL without an RPC call", async () => {
    enableCache();
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
    await expect(hasClaim(` ${WALLET} `, "kyc")).resolves.toBe(true);
    expect(isVerified).toHaveBeenCalledTimes(1);
  });

  it("caches definitive negative answers too", async () => {
    enableCache();
    isVerified.mockResolvedValue(notVerified());
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
    expect(isVerified).toHaveBeenCalledTimes(1);
  });

  it("keys threshold reads by (wallet, type, minThreshold)", async () => {
    enableCache();
    await hasClaim(WALLET, "age", { minThreshold: 18 });
    await hasClaim(WALLET, "age", { minThreshold: 18 });
    expect(checkClaim).toHaveBeenCalledTimes(1);

    await hasClaim(WALLET, "age", { minThreshold: 21 });
    await hasClaim(WALLET, "age"); // no threshold: is_verified, separate entry
    await hasClaim(OTHER, "age", { minThreshold: 18 });
    expect(checkClaim).toHaveBeenCalledTimes(3);
    expect(isVerified).toHaveBeenCalledTimes(1);
  });

  it("misses for a different credential type, issuer set or source", async () => {
    enableCache();
    await hasClaim(WALLET, "kyc");
    await hasClaim(WALLET, "age");
    await hasClaim(WALLET, "kyc", { trustedIssuers: ["GISSUERA"] });
    await hasClaim(WALLET, "kyc", { trustedIssuers: [] });
    expect(isVerified).toHaveBeenCalledTimes(4);
  });

  it("treats trusted issuers as a set", async () => {
    enableCache();
    await hasClaim(WALLET, "kyc", { trustedIssuers: ["GISSUERA", "GISSUERB"] });
    await hasClaim(WALLET, "kyc", { trustedIssuers: ["GISSUERB", "GISSUERA"] });
    expect(isVerified).toHaveBeenCalledTimes(1);
  });

  it("is shared by hasClaim, hasClaims, getClaim and verifyPreset", async () => {
    enableCache();
    await hasClaims(WALLET, ["kyc", "age"], { minThresholds: { age: 18 } });
    expect(isVerified).toHaveBeenCalledTimes(1);
    expect(checkClaim).toHaveBeenCalledTimes(1);

    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
    await expect(getClaim(WALLET, "kyc")).resolves.toMatchObject({ valid: true });
    await expect(
      verifyPreset(WALLET, [{ type: "kyc" }, { type: "age", minThreshold: 18 }]),
    ).resolves.toMatchObject({ allValid: true });
    expect(isVerified).toHaveBeenCalledTimes(1);
    expect(checkClaim).toHaveBeenCalledTimes(1);
  });

  it("does not let a caller mutate a cached record", async () => {
    enableCache();
    const first = await getClaim(WALLET, "kyc");
    first!.valid = false;
    first!.expiry = 0;
    await expect(getClaim(WALLET, "kyc")).resolves.toMatchObject({
      valid: true,
      expiry: Number(FAR_FUTURE),
    });
  });
});

describe("claim cache — failures are never cached", () => {
  it("does not cache a fail-soft false from an RPC error", async () => {
    enableCache();
    isVerified.mockRejectedValueOnce(new Error("rpc down"));
    await expect(hasClaim(WALLET, "kyc", { retryOptions: NO_RETRY })).resolves.toBe(false);
    await expect(hasClaim(WALLET, "kyc", { retryOptions: NO_RETRY })).resolves.toBe(true);
    expect(isVerified).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed threshold read", async () => {
    enableCache();
    checkClaim.mockRejectedValueOnce(new Error("rpc down"));
    const opts = { minThreshold: 18, retryOptions: NO_RETRY };
    await expect(hasClaim(WALLET, "age", opts)).resolves.toBe(false);
    await expect(hasClaim(WALLET, "age", opts)).resolves.toBe(true);
    expect(checkClaim).toHaveBeenCalledTimes(2);
  });

  it("does not cache when throwOnError surfaces the failure", async () => {
    enableCache();
    isVerified.mockRejectedValueOnce(new Error("rpc down"));
    await expect(
      hasClaim(WALLET, "kyc", { throwOnError: true, retryOptions: NO_RETRY }),
    ).rejects.toThrow();
    expect(getClaimCacheSize()).toBe(0);
  });

  it("does not cache reads made while unconfigured", async () => {
    configure({ claimCache: true, registryId: "" });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
    expect(getClaimCacheSize()).toBe(0);
  });
});

describe("claim cache — expiry", () => {
  it("expires entries after the default 30s TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    enableCache();

    await hasClaim(WALLET, "kyc");
    vi.setSystemTime(Date.now() + 29_999);
    await hasClaim(WALLET, "kyc");
    expect(isVerified).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1);
    await hasClaim(WALLET, "kyc");
    expect(isVerified).toHaveBeenCalledTimes(2);
  });

  it("honours a configured TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    enableCache({ claimCacheTtlMs: 1_000 });

    await hasClaim(WALLET, "kyc");
    vi.setSystemTime(Date.now() + 1_000);
    await hasClaim(WALLET, "kyc");
    expect(isVerified).toHaveBeenCalledTimes(2);
  });

  it("never serves a valid answer past the credential's own expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-10-21T12:00:00Z").getTime();
    vi.setSystemTime(now);
    enableCache();
    // Credential expires 5s from now, well inside the 30s TTL.
    isVerified.mockResolvedValueOnce(verified(BigInt(Math.floor(now / 1000) + 5)));
    isVerified.mockResolvedValueOnce(notVerified());

    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
    vi.setSystemTime(now + 5_000);
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
    expect(isVerified).toHaveBeenCalledTimes(2);
  });
});

describe("claim cache — invalidate", () => {
  it("invalidate(wallet) clears every entry for that wallet only", async () => {
    enableCache();
    await hasClaim(WALLET, "kyc");
    await hasClaim(WALLET, "age", { minThreshold: 18 });
    await hasClaim(OTHER, "kyc");
    expect(getClaimCacheSize()).toBe(3);

    expect(invalidateClaimCache(WALLET)).toBe(2);
    expect(getClaimCacheSize()).toBe(1);

    await hasClaim(WALLET, "kyc");
    await hasClaim(WALLET, "age", { minThreshold: 18 });
    await hasClaim(OTHER, "kyc");
    expect(isVerified).toHaveBeenCalledTimes(3);
    expect(checkClaim).toHaveBeenCalledTimes(2);
  });

  it("invalidate(wallet, credentialType) clears only that type", async () => {
    enableCache();
    await hasClaim(WALLET, "kyc");
    await hasClaim(WALLET, "age", { minThreshold: 18 });
    await hasClaim(WALLET, "age", { minThreshold: 21 });

    expect(invalidateClaimCache(WALLET, "age")).toBe(2);
    await hasClaim(WALLET, "kyc");
    expect(isVerified).toHaveBeenCalledTimes(1);
    await hasClaim(WALLET, "age", { minThreshold: 18 });
    expect(checkClaim).toHaveBeenCalledTimes(3);
  });

  it("picks up a new submission immediately after invalidating", async () => {
    enableCache();
    isVerified.mockResolvedValueOnce(notVerified());
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);

    // The proof lands on-chain; the cached `false` would hide it for 30s.
    isVerified.mockResolvedValue(verified());
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
    StellarCred.invalidate(` ${WALLET} `, "kyc");
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
  });

  it("does not cache a read that was in flight when invalidate was called", async () => {
    enableCache();
    let release!: (v: unknown) => void;
    isVerified.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));

    const pending = hasClaim(WALLET, "kyc");
    await vi.waitFor(() => expect(isVerified).toHaveBeenCalledTimes(1));
    invalidateClaimCache(WALLET);
    release(notVerified()); // pre-submission answer
    await expect(pending).resolves.toBe(false);

    expect(getClaimCacheSize()).toBe(0);
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
  });

  it("clearClaimCache empties everything", async () => {
    enableCache();
    await hasClaim(WALLET, "kyc");
    await hasClaim(OTHER, "kyc");
    clearClaimCache();
    expect(getClaimCacheSize()).toBe(0);
  });

  it("is a no-op when the cache is disabled", () => {
    configure({ registryId: "C_TEST_REGISTRY" });
    expect(invalidateClaimCache(WALLET)).toBe(0);
  });
});

describe("claim cache — bypass", () => {
  it("fresh: true skips the cache and refreshes it", async () => {
    enableCache();
    isVerified.mockResolvedValueOnce(notVerified());
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);

    await expect(hasClaim(WALLET, "kyc", { fresh: true })).resolves.toBe(true);
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
    expect(isVerified).toHaveBeenCalledTimes(2);
  });

  it("watchClaim polls past a cached negative answer", async () => {
    enableCache();
    isVerified.mockResolvedValueOnce(notVerified());
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);

    isVerified.mockResolvedValue(verified());
    await expect(watchClaim(WALLET, "kyc", { pollMs: 10, timeoutMs: 1_000 })).resolves.toBe(true);
  });
});

describe("ClaimCache store", () => {
  const key = (claimType: string) => claimCacheKey({ wallet: WALLET, claimType, source: "chain" });

  it("evicts the oldest entries beyond maxEntries", () => {
    const cache = new ClaimCache();
    const gen = cache.generation;
    const later = Date.now() + 60_000;
    for (const t of ["a", "b", "c"]) {
      cache.set(key(t), { wallet: WALLET, claimType: t }, true, later, 2, gen);
    }
    expect(cache.size).toBe(2);
    expect(cache.get(key("a"))).toBeUndefined();
    expect(cache.get(key("c"))).toEqual({ value: true });
  });

  it("refuses writes from a read that started before an invalidation", () => {
    const cache = new ClaimCache();
    const gen = cache.generation;
    cache.invalidate(OTHER);
    expect(
      cache.set(key("kyc"), { wallet: WALLET, claimType: "kyc" }, true, Date.now() + 1000, 10, gen),
    ).toBe(false);
    expect(cache.size).toBe(0);
  });

  it("keeps an unrestricted issuer set distinct from an empty one", () => {
    const base = { wallet: WALLET, claimType: "kyc", source: "chain" };
    expect(claimCacheKey(base)).not.toBe(claimCacheKey({ ...base, trustedIssuers: [] }));
  });
});
