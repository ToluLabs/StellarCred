// Tests for the optional indexer read path (issue #613).
//
// Two layers are covered:
//   1. Pure evaluation logic in ./indexer — must reproduce the contract's
//      `is_verified` / `check_claim` predicates exactly.
//   2. Routing in ./claims — default stays on chain, opt-in sources work, and
//      `indexer-verified` keeps the chain authoritative.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const isVerified = vi.fn();
const checkClaim = vi.fn();

vi.mock("../../proof-registry/src/index", () => ({
  Client: vi.fn(function ProofRegistryClient() {
    return { is_verified: isVerified, check_claim: checkClaim };
  }),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {},
  StrKey: {
    isValidEd25519PublicKey: vi.fn(
      (address: string) => address === WALLET,
    ),
  },
}));

import {
  configure,
  resetConfig,
  resetClientForTesting,
  resetIndexerForTesting,
  hasClaim,
  getClaim,
  getClaims,
  hasClaims,
  ConfigError,
  IndexerError,
  CLAIM_TYPES,
} from "./claims";
import { evaluateClaimRow, issuerIsTrusted, type IndexerClaimRow } from "./indexer";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ISSUER = "GISSUERISSUERISSUERISSUERISSUERIS";
const INDEXER_URL = "https://indexer.test";

const nowSeconds = () => Math.floor(Date.now() / 1000);

function row(overrides: Partial<IndexerClaimRow> = {}): IndexerClaimRow {
  return {
    id: 1,
    wallet: WALLET,
    credential_type: "kyc",
    issuer: ISSUER,
    verified_at: nowSeconds() - 1000,
    expiry: nowSeconds() + 10_000,
    ledger_sequence: 100,
    threshold: null,
    revoked: 0,
    ...overrides,
  };
}

type RecordedRequest = { url: string; headers: Record<string, string> };

/**
 * Installs a fetch mock that serves `claims` for any wallet.
 *
 * The impl declares fetch's real parameter list and records requests itself
 * rather than relying on `mock.calls` tuple inference, which resolves to `[]`
 * when the mock is parameterless.
 */
function mockIndexer(claims: IndexerClaimRow[], status = 200) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: (init?.headers ?? {}) as unknown as Record<string, string>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ wallet: WALLET, claims }),
    };
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return Object.assign(fetchMock, { requests });
}

/** Chain mock returning `(valid, verified_at, expiry)` like the contract. */
function mockChainValid(valid: boolean) {
  isVerified.mockResolvedValue({
    result: [valid, BigInt(nowSeconds() - 1000), BigInt(nowSeconds() + 10_000)],
  });
  checkClaim.mockResolvedValue({ result: valid });
}

beforeEach(() => {
  resetConfig();
  resetClientForTesting();
  resetIndexerForTesting();
  isVerified.mockReset();
  checkClaim.mockReset();
  configure({ registryId: "C_TEST_REGISTRY", indexerUrl: INDEXER_URL });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Pure evaluation: must mirror the contract ───────────────────────────────

describe("evaluateClaimRow (contract parity)", () => {
  const opts = { nowSeconds: nowSeconds() };

  it("accepts an unrevoked, unexpired claim", () => {
    expect(evaluateClaimRow(row(), opts)).toBe(true);
  });

  it("rejects a revoked claim", () => {
    expect(evaluateClaimRow(row({ revoked: 1 }), opts)).toBe(false);
  });

  it("rejects an expired claim", () => {
    expect(
      evaluateClaimRow(row({ expiry: nowSeconds() - 1 }), opts),
    ).toBe(false);
  });

  // The contract uses `expiry > timestamp`, so equality is NOT valid.
  it("rejects a claim expiring exactly now (strict comparison)", () => {
    const now = nowSeconds();
    expect(evaluateClaimRow(row({ expiry: now }), { nowSeconds: now })).toBe(
      false,
    );
  });

  it("treats a null threshold as 0", () => {
    expect(
      evaluateClaimRow(row({ threshold: null }), {
        ...opts,
        minThreshold: 0,
      }),
    ).toBe(true);
    expect(
      evaluateClaimRow(row({ threshold: null }), {
        ...opts,
        minThreshold: 1,
      }),
    ).toBe(false);
  });

  it("accepts when the stored threshold meets the minimum", () => {
    expect(
      evaluateClaimRow(row({ threshold: 21 }), { ...opts, minThreshold: 18 }),
    ).toBe(true);
    expect(
      evaluateClaimRow(row({ threshold: 17 }), { ...opts, minThreshold: 18 }),
    ).toBe(false);
  });
});

describe("issuerIsTrusted (contract parity)", () => {
  it("accepts any issuer when no filter is given", () => {
    expect(issuerIsTrusted(ISSUER, undefined)).toBe(true);
    expect(issuerIsTrusted("", undefined)).toBe(true);
  });

  it("accepts an issuer present in the filter", () => {
    expect(issuerIsTrusted(ISSUER, [ISSUER])).toBe(true);
  });

  it("rejects an issuer absent from the filter", () => {
    expect(issuerIsTrusted(ISSUER, ["GOTHER"])).toBe(false);
  });

  // Contract: `Some(list)` + record with no issuer => false.
  it("rejects a row with no issuer when a filter is set", () => {
    expect(issuerIsTrusted("", [ISSUER])).toBe(false);
  });

  it("rejects everything when the filter is an empty list", () => {
    expect(issuerIsTrusted(ISSUER, [])).toBe(false);
  });
});

// ── Routing ─────────────────────────────────────────────────────────────────

describe("source defaults to chain", () => {
  it("does not contact the indexer when source is omitted", async () => {
    const fetchMock = mockIndexer([row()]);
    mockChainValid(true);

    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isVerified).toHaveBeenCalledTimes(1);
  });

  it("does not contact the indexer for an explicit chain source", async () => {
    const fetchMock = mockIndexer([row()]);
    mockChainValid(true);

    await expect(hasClaim(WALLET, "kyc", { source: "chain" })).resolves.toBe(
      true,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('source: "indexer"', () => {
  it("reads from the indexer and skips the chain entirely", async () => {
    mockIndexer([row()]);

    await expect(
      hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } }),
    ).resolves.toBe(true);
    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("returns false for a revoked row", async () => {
    mockIndexer([row({ revoked: 1 })]);

    await expect(
      hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } }),
    ).resolves.toBe(false);
  });

  it("returns false when the wallet has no row for that type", async () => {
    mockIndexer([row({ credential_type: "age" })]);

    await expect(
      hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } }),
    ).resolves.toBe(false);
  });

  it("getClaim returns the record shape, mirroring the contract", async () => {
    const r = row({ verified_at: 1_700_000_000, expiry: 1_800_000_000 });
    mockIndexer([r]);

    await expect(
      getClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } }),
    ).resolves.toEqual({
      valid: true,
      verifiedAt: 1_700_000_000,
      expiry: 1_800_000_000,
    });
  });

  it("getClaim returns null for an invalid claim", async () => {
    mockIndexer([row({ revoked: 1 })]);

    await expect(
      getClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } }),
    ).resolves.toBeNull();
  });

  it("applies trustedIssuers against the indexer row", async () => {
    mockIndexer([row()]);

    await expect(
      hasClaim(WALLET, "kyc", {
        source: "indexer",
        trustedIssuers: ["GOTHER"],
        retryOptions: { retries: 0 },
      }),
    ).resolves.toBe(false);

    await expect(
      hasClaim(WALLET, "kyc", {
        source: "indexer",
        trustedIssuers: [ISSUER],
        retryOptions: { retries: 0 },
      }),
    ).resolves.toBe(true);
  });

  it("applies minThreshold against the indexer row", async () => {
    mockIndexer([row({ threshold: 10 })]);

    await expect(
      hasClaim(WALLET, "kyc", {
        source: "indexer",
        minThreshold: 20,
        retryOptions: { retries: 0 },
      }),
    ).resolves.toBe(false);

    await expect(
      hasClaim(WALLET, "kyc", {
        source: "indexer",
        minThreshold: 5,
        retryOptions: { retries: 0 },
      }),
    ).resolves.toBe(true);
  });

  it("issues one request for a getClaims fan-out over all types", async () => {
    const fetchMock = mockIndexer([
      row({ credential_type: "kyc" }),
      row({ credential_type: "age", id: 2 }),
    ]);

    const claims = await getClaims(WALLET, {
      source: "indexer",
      retryOptions: { retries: 0 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(claims.map((c) => c.type).sort()).toEqual(["age", "kyc"]);
    expect(claims).toHaveLength(2);
    expect(CLAIM_TYPES.length).toBeGreaterThan(1);
  });

  it("issues one request for a hasClaims fan-out", async () => {
    const fetchMock = mockIndexer([row({ credential_type: "kyc" })]);

    const results = await hasClaims(WALLET, ["kyc", "age"], {
      source: "indexer",
      retryOptions: { retries: 0 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual({ kyc: true, age: false });
  });

  it("sends the configured API key as a Bearer token", async () => {
    configure({ indexerApiKey: "secret-key" });
    const fetchMock = mockIndexer([row()]);

    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });

    expect(fetchMock.requests[0].headers.Authorization).toBe("Bearer secret-key");
  });

  it("sends no Authorization header when no key is configured", async () => {
    const fetchMock = mockIndexer([row()]);

    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });

    expect(fetchMock.requests[0].headers.Authorization).toBeUndefined();
  });

  it("passes the wallet as a query parameter", async () => {
    const fetchMock = mockIndexer([row()]);

    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });

    expect(fetchMock.requests[0].url).toBe(`${INDEXER_URL}/claims?wallet=${WALLET}`);
  });
});

describe('source: "indexer-verified"', () => {
  it("returns the chain result when both agree", async () => {
    mockIndexer([row()]);
    mockChainValid(true);

    await expect(
      hasClaim(WALLET, "kyc", {
        source: "indexer-verified",
        retryOptions: { retries: 0 },
      }),
    ).resolves.toBe(true);
    expect(isVerified).toHaveBeenCalledTimes(1);
  });

  it("returns the chain result when the indexer wrongly says valid", async () => {
    mockIndexer([row()]);
    mockChainValid(false);

    await expect(
      hasClaim(WALLET, "kyc", {
        source: "indexer-verified",
        retryOptions: { retries: 0 },
      }),
    ).resolves.toBe(false);
  });

  it("returns the chain result when the indexer wrongly says invalid", async () => {
    mockIndexer([row({ revoked: 1 })]);
    mockChainValid(true);

    await expect(
      hasClaim(WALLET, "kyc", {
        source: "indexer-verified",
        retryOptions: { retries: 0 },
      }),
    ).resolves.toBe(true);
  });

  it("warns once when the indexer and chain disagree", async () => {
    mockIndexer([row()]);
    mockChainValid(false);

    await hasClaim(WALLET, "kyc", {
      source: "indexer-verified",
      retryOptions: { retries: 0 },
    });
    await hasClaim(WALLET, "kyc", {
      source: "indexer-verified",
      retryOptions: { retries: 0 },
    });

    const driftWarnings = (console.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => String(call[0]).includes("disagreed with the chain"),
    );
    expect(driftWarnings).toHaveLength(1);
  });

  it("does not warn when the indexer and chain agree", async () => {
    mockIndexer([row()]);
    mockChainValid(true);

    await hasClaim(WALLET, "kyc", {
      source: "indexer-verified",
      retryOptions: { retries: 0 },
    });

    expect(console.warn).not.toHaveBeenCalled();
  });

  it("still returns the chain result when the indexer request fails", async () => {
    mockIndexer([], 500);
    mockChainValid(true);

    await expect(
      hasClaim(WALLET, "kyc", {
        source: "indexer-verified",
        retryOptions: { retries: 0 },
      }),
    ).resolves.toBe(true);
  });
});

// ── Failure modes ───────────────────────────────────────────────────────────

describe("indexer misconfiguration and failure", () => {
  it("fails soft to false when no indexerUrl is configured", async () => {
    resetConfig();
    configure({ registryId: "C_TEST_REGISTRY" });
    const fetchMock = mockIndexer([row()]);

    await expect(
      hasClaim(WALLET, "kyc", { source: "indexer" }),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws ConfigError with throwOnError when no indexerUrl is configured", async () => {
    resetConfig();
    configure({ registryId: "C_TEST_REGISTRY" });
    mockIndexer([row()]);

    await expect(
      hasClaim(WALLET, "kyc", { source: "indexer", throwOnError: true }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("fails soft to false on an HTTP error", async () => {
    mockIndexer([], 500);

    await expect(
      hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } }),
    ).resolves.toBe(false);
  });

  it("throws IndexerError with throwOnError on an HTTP error", async () => {
    mockIndexer([], 503);

    await expect(
      hasClaim(WALLET, "kyc", {
        source: "indexer",
        throwOnError: true,
        retryOptions: { retries: 0 },
      }),
    ).rejects.toBeInstanceOf(IndexerError);
  });

  it("throws IndexerError when the response body is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ unexpected: true }),
      })) as unknown as typeof fetch,
    );

    await expect(
      hasClaim(WALLET, "kyc", {
        source: "indexer",
        throwOnError: true,
        retryOptions: { retries: 0 },
      }),
    ).rejects.toBeInstanceOf(IndexerError);
  });

  it("does not cache a failed response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ wallet: WALLET, claims: [row()] }),
    }));
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } }),
    ).resolves.toBe(false);

    await expect(
      hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("indexer cache", () => {
  it("reuses rows within the cache window", async () => {
    const fetchMock = mockIndexer([row()]);

    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });
    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches after the cache window elapses", async () => {
    configure({ indexerCacheMs: 1 });
    const fetchMock = mockIndexer([row()]);

    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never caches when indexerCacheMs is 0", async () => {
    configure({ indexerCacheMs: 0 });
    const fetchMock = mockIndexer([row()]);

    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });
    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is cleared by configure() so a new indexerUrl is not served stale rows", async () => {
    const fetchMock = mockIndexer([row()]);

    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });
    configure({ indexerUrl: "https://other-indexer.test" });
    await hasClaim(WALLET, "kyc", { source: "indexer", retryOptions: { retries: 0 } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.requests[1].url).toContain("https://other-indexer.test");
  });
});
