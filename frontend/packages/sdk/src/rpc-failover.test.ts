import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Per-URL mock behavior registry for ProofRegistryClient & rpc.Server.
const proofClientByUrl = new Map<
  string,
  {
    is_verified: ReturnType<typeof vi.fn>;
    check_claim: ReturnType<typeof vi.fn>;
    get_record: ReturnType<typeof vi.fn>;
    is_nullifier_used: ReturnType<typeof vi.fn>;
  }
>();

const sorobanServerByUrl = new Map<string, { simulateTransaction: ReturnType<typeof vi.fn> }>();

function ensureProofClient(url: string) {
  let entry = proofClientByUrl.get(url);
  if (!entry) {
    entry = {
      is_verified: vi.fn(),
      check_claim: vi.fn(),
      get_record: vi.fn(),
      is_nullifier_used: vi.fn(),
    };
    proofClientByUrl.set(url, entry);
  }
  return entry;
}

function ensureSorobanServer(url: string) {
  let entry = sorobanServerByUrl.get(url);
  if (!entry) {
    entry = { simulateTransaction: vi.fn() };
    sorobanServerByUrl.set(url, entry);
  }
  return entry;
}

vi.mock("../../proof-registry/src/index", () => ({
  Client: vi.fn(function MockProofRegistryClient(opts: { rpcUrl: string }) {
    return ensureProofClient(opts.rpcUrl);
  }),
}));

vi.mock("@stellar/stellar-sdk", () => {
  class MockServer {
    private readonly url: string;
    constructor(url: string) {
      this.url = url;
    }
    simulateTransaction(tx: unknown) {
      return ensureSorobanServer(this.url).simulateTransaction(tx);
    }
  }
  return {
    rpc: {
      Server: MockServer,
      Api: {
        isSimulationError: (sim: Record<string, unknown>) => "error" in sim,
      },
    },
    StrKey: {
      isValidEd25519PublicKey: vi.fn(
        (address: string) => address === "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      ),
    },
    Account: vi.fn(function MockAccount(id: string, seq: string) {
      return { id, seq };
    }),
    Contract: vi.fn(function MockContract(id: string) {
      return {
        call: (...args: unknown[]) => ({ contractId: id, args }),
      };
    }),
    TransactionBuilder: vi.fn(function MockTxBuilder() {
      return {
        addOperation() {
          return this;
        },
        setTimeout() {
          return this;
        },
        build() {
          return { built: true };
        },
      };
    }),
    BASE_FEE: "100",
    Address: {
      fromString: (value: string) => ({ toScVal: () => ({ address: value }) }),
    },
    scValToNative: (val: unknown) => val,
    nativeToScVal: (val: unknown) => val,
  };
});

import {
  configure,
  getConfig,
  resetConfig,
  resetClientForTesting,
  hasClaim,
  getClaimRecord,
  isNullifierUsed,
  getIssuer,
  executeWithRpcFailover,
  executeWithHorizonFailover,
  fetchHorizon,
  getRpcHealth,
  getHorizonHealth,
  resetRpcHealth,
  RpcFailoverPool,
  createRpcFailoverPool,
  classifyFailoverFailure,
  fetchWithFailover,
  normalizeEndpointUrls,
  parseEndpointListEnv,
  isValidHttpEndpointUrl,
  ConfigError,
  InvalidAddressError,
  RpcError,
  ContractError,
  ContractErrorCode,
  TimeoutError,
  type RpcFailoverEvent,
} from "./index";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RPC_1 = "https://rpc-primary.example.org";
const RPC_2 = "https://rpc-secondary.example.org";
const RPC_3 = "https://rpc-tertiary.example.org";
const HORIZON_1 = "https://horizon-primary.example.org";
const HORIZON_2 = "https://horizon-secondary.example.org";

beforeEach(() => {
  proofClientByUrl.clear();
  sorobanServerByUrl.clear();
  resetConfig();
  resetClientForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// URL normalization & env parsing
// ---------------------------------------------------------------------------

describe("endpoint URL normalization & env parsing", () => {
  it("validates http and https endpoints only", () => {
    expect(isValidHttpEndpointUrl("https://soroban-testnet.stellar.org")).toBe(true);
    expect(isValidHttpEndpointUrl("http://localhost:8000/soroban/rpc")).toBe(true);
    expect(isValidHttpEndpointUrl("ftp://example.org")).toBe(false);
    expect(isValidHttpEndpointUrl("ws://example.org")).toBe(false);
    expect(isValidHttpEndpointUrl("not-a-url")).toBe(false);
    expect(isValidHttpEndpointUrl("")).toBe(false);
  });

  it("trims and deduplicates endpoint arrays while preserving priority order", () => {
    expect(normalizeEndpointUrls([`  ${RPC_1}  `, RPC_2, RPC_1, ` ${RPC_3}`])).toEqual([
      RPC_1,
      RPC_2,
      RPC_3,
    ]);
  });

  it("rejects invalid URLs in normalizeEndpointUrls", () => {
    expect(() => normalizeEndpointUrls([RPC_1, "not-a-url"])).toThrow(/invalid HTTP\(S\) URL/i);
  });

  it("parses comma-separated endpoint lists from env strings", () => {
    expect(parseEndpointListEnv(` ${RPC_1}, , ${RPC_2} ,${RPC_3} `)).toEqual([RPC_1, RPC_2, RPC_3]);
    expect(parseEndpointListEnv(undefined)).toEqual([]);
    expect(parseEndpointListEnv("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

describe("classifyFailoverFailure", () => {
  it("classifies 5xx, 429, 408, timeouts, and network errors as failover-eligible", () => {
    expect(classifyFailoverFailure(new RpcError("Bad Gateway", { status: 502 }))).toEqual({
      reason: "server_error",
      statusCode: 502,
    });
    expect(classifyFailoverFailure(new RpcError("Service Unavailable", { status: 503 }))).toEqual({
      reason: "server_error",
      statusCode: 503,
    });
    expect(classifyFailoverFailure(new RpcError("Gateway Timeout", { status: 504 }))).toEqual({
      reason: "timeout",
      statusCode: 504,
    });
    expect(classifyFailoverFailure(new RpcError("Request Timeout", { status: 408 }))).toEqual({
      reason: "timeout",
      statusCode: 408,
    });
    expect(classifyFailoverFailure(new RpcError("Rate limited", { status: 429 }))).toEqual({
      reason: "rate_limited",
      statusCode: 429,
    });
    expect(classifyFailoverFailure(new TimeoutError("timed out"))).toEqual({
      reason: "timeout",
    });
    expect(classifyFailoverFailure(new Error("RPC read timed out after 5000ms"))).toEqual({
      reason: "timeout",
    });
    expect(classifyFailoverFailure(new Error("ECONNREFUSED 127.0.0.1:8000"))).toEqual({
      reason: "network_error",
    });
    expect(classifyFailoverFailure({ response: { status: 500 } })).toEqual({
      reason: "server_error",
      statusCode: 500,
    });
  });

  it("returns null for terminal, contract, validation, and non-transient 4xx errors", () => {
    const contractErr = new ContractError(
      ContractErrorCode.VerificationFailed,
      "Proof verification failed",
      "Error(Contract, #2)",
    );
    expect(classifyFailoverFailure(contractErr)).toBeNull();
    expect(
      classifyFailoverFailure(new RpcError("Contract panic", { contractError: contractErr })),
    ).toBeNull();
    expect(classifyFailoverFailure(new ConfigError("missing"))).toBeNull();
    expect(classifyFailoverFailure(new InvalidAddressError("bad"))).toBeNull();
    expect(classifyFailoverFailure(new RpcError("Bad Request", { status: 400 }))).toBeNull();
    expect(classifyFailoverFailure(new RpcError("Unauthorized", { status: 401 }))).toBeNull();
    expect(classifyFailoverFailure(new RpcError("Not Found", { status: 404 }))).toBeNull();
    expect(classifyFailoverFailure(new Error("invalid argument supplied"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RpcFailoverPool unit tests
// ---------------------------------------------------------------------------

describe("RpcFailoverPool", () => {
  it("validates constructor arguments", () => {
    expect(() => createRpcFailoverPool([])).toThrow(/at least one valid endpoint/i);
    expect(() => createRpcFailoverPool(["ftp://bad.example"])).toThrow(/invalid HTTP\(S\) URL/i);
    expect(() => createRpcFailoverPool([RPC_1], "soroban", { cooldownMs: -1 })).toThrow(
      /cooldownMs/,
    );
    expect(() => createRpcFailoverPool([RPC_1], "soroban", { failureThreshold: 0 })).toThrow(
      /failureThreshold/,
    );
  });

  it("fails over in priority order on 5xx, 429, and timeout and emits failover events", async () => {
    let now = 1_000;
    const events: RpcFailoverEvent[] = [];
    const pool = new RpcFailoverPool([RPC_1, RPC_2, RPC_3], "soroban", {
      cooldownMs: 30_000,
      now: () => now,
      onFailover: (ev) => events.push(ev),
    });

    const tried: string[] = [];
    const result = await pool.execute(async (url) => {
      tried.push(url);
      if (url === RPC_1) throw new RpcError("503", { status: 503 });
      if (url === RPC_2) throw new Error("RPC read timed out after 1000ms");
      return "ok-from-3";
    });

    expect(result).toBe("ok-from-3");
    expect(tried).toEqual([RPC_1, RPC_2, RPC_3]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "soroban",
      fromUrl: RPC_1,
      toUrl: RPC_2,
      reason: "server_error",
      statusCode: 503,
      attempt: 1,
    });
    expect(events[1]).toMatchObject({
      kind: "soroban",
      fromUrl: RPC_2,
      toUrl: RPC_3,
      reason: "timeout",
      attempt: 2,
    });

    // Subsequent call skips cooling-down RPC_1 and RPC_2 and goes straight to RPC_3.
    const nextTried: string[] = [];
    await pool.execute(async (url) => {
      nextTried.push(url);
      return "fast-path";
    });
    expect(nextTried).toEqual([RPC_3]);

    // After cooldown expires, primary RPC_1 is probed first again.
    now += 31_000;
    const afterCooldownTried: string[] = [];
    await pool.execute(async (url) => {
      afterCooldownTried.push(url);
      return "recovered";
    });
    expect(afterCooldownTried).toEqual([RPC_1]);
    expect(pool.getHealthSnapshot()[0].healthy).toBe(true);
    expect(pool.getHealthSnapshot()[0].consecutiveFailures).toBe(0);
  });

  it("respects failureThreshold before entering cooldown", async () => {
    const now = 5_000;
    const pool = new RpcFailoverPool([RPC_1, RPC_2], "soroban", {
      cooldownMs: 30_000,
      failureThreshold: 2,
      now: () => now,
    });

    // First failure fails over to RPC_2, but RPC_1 is not yet in cooldown.
    await pool.execute(async (url) => {
      if (url === RPC_1) throw new RpcError("500", { status: 500 });
      return "from-2";
    });
    expect(pool.getHealthSnapshot()[0].healthy).toBe(true);
    expect(pool.getHealthSnapshot()[0].consecutiveFailures).toBe(1);

    // Second consecutive failure puts RPC_1 into cooldown.
    await pool.execute(async (url) => {
      if (url === RPC_1) throw new RpcError("500", { status: 500 });
      return "from-2-again";
    });
    expect(pool.getHealthSnapshot()[0].healthy).toBe(false);
    expect(pool.getActiveUrl()).toBe(RPC_2);
  });

  it("falls back to least-recently-failed endpoint when all nodes are in cooldown", async () => {
    let now = 1_000;
    const pool = new RpcFailoverPool([RPC_1, RPC_2], "soroban", {
      cooldownMs: 30_000,
      now: () => now,
    });

    pool.markUnhealthy(RPC_1, "server_error"); // cooldownUntil = 31_000
    now = 5_000;
    pool.markUnhealthy(RPC_2, "timeout"); // cooldownUntil = 35_000

    // Both are in cooldown; RPC_1 has the earlier cooldownUntil so it is tried first.
    expect(pool.getOrderedCandidates()).toEqual([RPC_1, RPC_2]);
  });

  it("does not fail over or mark node unhealthy on terminal 4xx or contract errors", async () => {
    const pool = new RpcFailoverPool([RPC_1, RPC_2], "soroban");
    const tried: string[] = [];

    await expect(
      pool.execute(async (url) => {
        tried.push(url);
        throw new RpcError("Bad Request", { status: 400 });
      }),
    ).rejects.toThrow("Bad Request");

    expect(tried).toEqual([RPC_1]);
    expect(pool.getHealthSnapshot()[0].healthy).toBe(true);
    expect(pool.getHealthSnapshot()[0].consecutiveFailures).toBe(0);
  });

  it("aborts immediately when AbortSignal is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const pool = new RpcFailoverPool([RPC_1, RPC_2], "soroban");
    const op = vi.fn();

    await expect(pool.execute(op, { signal: controller.signal })).rejects.toThrow(
      "caller cancelled",
    );
    expect(op).not.toHaveBeenCalled();
  });

  it("swallows errors thrown by onFailover hooks", async () => {
    const pool = new RpcFailoverPool([RPC_1, RPC_2], "soroban", {
      onFailover: () => {
        throw new Error("broken logger");
      },
    });

    const result = await pool.execute(
      async (url) => {
        if (url === RPC_1) throw new RpcError("502", { status: 502 });
        return "recovered";
      },
      {
        onFailover: () => {
          throw new Error("broken per-call logger");
        },
      },
    );

    expect(result).toBe("recovered");
  });
});

// ---------------------------------------------------------------------------
// Horizon failover (fetchWithFailover & fetchHorizon)
// ---------------------------------------------------------------------------

describe("Horizon failover (fetchWithFailover / fetchHorizon)", () => {
  it("fails over across Horizon nodes on HTTP 503 and HTTP 429", async () => {
    configure({
      horizonUrls: [HORIZON_1, HORIZON_2],
      requestTimeoutMs: 2_000,
    });

    const requested: string[] = [];
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith(HORIZON_1)) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ id: WALLET }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await fetchHorizon(`/accounts/${WALLET}`, {
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: WALLET });
    expect(requested).toEqual([
      `${HORIZON_1}/accounts/${WALLET}`,
      `${HORIZON_2}/accounts/${WALLET}`,
    ]);

    const health = getHorizonHealth();
    expect(health[0]).toMatchObject({
      url: HORIZON_1,
      healthy: false,
      lastErrorReason: "server_error",
    });
    expect(health[1]).toMatchObject({ url: HORIZON_2, healthy: true });
  });

  it("fails over across Horizon nodes on request timeout", async () => {
    vi.useFakeTimers();
    const pool = createRpcFailoverPool([HORIZON_1, HORIZON_2], "horizon");

    const mockFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(HORIZON_1)) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    const promise = fetchWithFailover(pool, "/ledgers", {
      timeoutMs: 50,
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await vi.advanceTimersByTimeAsync(50);
    const res = await promise;

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(pool.getHealthSnapshot()[0].lastErrorReason).toBe("timeout");
  });

  it("returns HTTP 404 directly without failing over to secondary Horizon node", async () => {
    configure({ horizonUrls: [HORIZON_1, HORIZON_2] });

    const mockFetch = vi.fn(async () => new Response("Not Found", { status: 404 }));
    const res = await fetchHorizon(`/accounts/${WALLET}`, {
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(res.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getHorizonHealth()[0].healthy).toBe(true);
  });

  it("supports custom operations via executeWithHorizonFailover", async () => {
    configure({ horizonUrls: [HORIZON_1, HORIZON_2] });
    const urls: string[] = [];

    const sequence = await executeWithHorizonFailover(async (horizonUrl) => {
      urls.push(horizonUrl);
      if (horizonUrl === HORIZON_1) {
        throw new RpcError("Rate limited", { status: 429 });
      }
      return 12345;
    });

    expect(sequence).toBe(12345);
    expect(urls).toEqual([HORIZON_1, HORIZON_2]);
  });
});

// ---------------------------------------------------------------------------
// SDK configuration & end-to-end Soroban failover integration
// ---------------------------------------------------------------------------

describe("SDK configuration for prioritized rpcUrls & horizonUrls", () => {
  it("syncs rpcUrl/rpcUrls and horizonUrl/horizonUrls cleanly", () => {
    configure({
      rpcUrls: [RPC_1, RPC_2, RPC_1],
      horizonUrls: [HORIZON_1, HORIZON_2],
    });
    const cfg = getConfig();
    expect(cfg.rpcUrl).toBe(RPC_1);
    expect(cfg.rpcUrls).toEqual([RPC_1, RPC_2]);
    expect(cfg.horizonUrl).toBe(HORIZON_1);
    expect(cfg.horizonUrls).toEqual([HORIZON_1, HORIZON_2]);
  });

  it("throws ConfigError on empty or invalid rpcUrls / horizonUrls / failover config", () => {
    expect(() => configure({ rpcUrls: [] })).toThrow(ConfigError);
    expect(() => configure({ rpcUrls: ["not-a-url"] })).toThrow(ConfigError);
    expect(() => configure({ horizonUrls: [] })).toThrow(ConfigError);
    expect(() => configure({ horizonUrls: ["ws://invalid"] })).toThrow(ConfigError);
    expect(() => configure({ failover: { cooldownMs: -10 } })).toThrow(ConfigError);
    expect(() => configure({ failover: { failureThreshold: 0 } })).toThrow(ConfigError);
  });
});

describe("SDK Soroban read failover integration", () => {
  it("hasClaim fails over from 503 primary Soroban node to healthy secondary node", async () => {
    const events: RpcFailoverEvent[] = [];
    configure({
      registryId: "C_TEST_REGISTRY",
      rpcUrls: [RPC_1, RPC_2],
      retries: 0,
      failover: { onFailover: (ev) => events.push(ev) },
    });

    ensureProofClient(RPC_1).is_verified.mockRejectedValue(
      new RpcError("Service Unavailable", { status: 503 }),
    );
    ensureProofClient(RPC_2).is_verified.mockResolvedValue({
      result: [true, 1_700_000_000n, 1_800_000_000n],
    });

    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
    expect(ensureProofClient(RPC_1).is_verified).toHaveBeenCalledTimes(1);
    expect(ensureProofClient(RPC_2).is_verified).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "soroban",
      fromUrl: RPC_1,
      toUrl: RPC_2,
      reason: "server_error",
      statusCode: 503,
    });

    // Next call routes straight to healthy RPC_2 while RPC_1 is in cooldown.
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
    expect(ensureProofClient(RPC_1).is_verified).toHaveBeenCalledTimes(1);
    expect(ensureProofClient(RPC_2).is_verified).toHaveBeenCalledTimes(2);

    // resetRpcHealth restores primary eligibility.
    resetRpcHealth();
    expect(getRpcHealth().every((ep) => ep.healthy)).toBe(true);
  });

  it("hasClaim fails over when primary Soroban node times out", async () => {
    configure({
      registryId: "C_TEST_REGISTRY",
      rpcUrls: [RPC_1, RPC_2],
      requestTimeoutMs: 25,
      retries: 0,
    });

    ensureProofClient(RPC_1).is_verified.mockImplementation(() => new Promise(() => {}));
    ensureProofClient(RPC_2).is_verified.mockResolvedValue({
      result: [true, 1_700_000_000n, 1_800_000_000n],
    });

    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
    expect(ensureProofClient(RPC_1).is_verified).toHaveBeenCalledTimes(1);
    expect(ensureProofClient(RPC_2).is_verified).toHaveBeenCalledTimes(1);
    expect(getRpcHealth()[0]).toMatchObject({
      url: RPC_1,
      healthy: false,
      lastErrorReason: "timeout",
    });
  });

  it("check_claim, get_record, and isNullifierUsed all fail over across Soroban nodes", async () => {
    configure({
      registryId: "C_TEST_REGISTRY",
      rpcUrls: [RPC_1, RPC_2],
      retries: 0,
      failover: { cooldownMs: 0 }, // probe primary on every call in this test
    });

    ensureProofClient(RPC_1).check_claim.mockRejectedValue(
      new RpcError("Bad Gateway", { status: 502 }),
    );
    ensureProofClient(RPC_2).check_claim.mockResolvedValue({ result: true });
    await expect(hasClaim(WALLET, "age", { minThreshold: 21 })).resolves.toBe(true);

    ensureProofClient(RPC_1).get_record.mockRejectedValue(
      new RpcError("Rate Limited", { status: 429 }),
    );
    ensureProofClient(RPC_2).get_record.mockResolvedValue({
      result: {
        verified_at: 100n,
        expiry: 200n,
        revoked: false,
        vk_version: 1,
      },
    });
    const record = await getClaimRecord(WALLET, "kyc");
    expect(record).toMatchObject({ verifiedAt: 100, expiry: 200, revoked: false, vkVersion: 1 });

    ensureProofClient(RPC_1).is_nullifier_used.mockRejectedValue(new Error("ECONNRESET"));
    ensureProofClient(RPC_2).is_nullifier_used.mockResolvedValue({ result: true });
    await expect(isNullifierUsed("app-1", "nullifier-1")).resolves.toBe(true);
  });

  it("getIssuer fails over across configured Soroban RPC nodes", async () => {
    configure({
      issuerRegistryId: "C_TEST_ISSUER_REGISTRY",
      rpcUrls: [RPC_1, RPC_2],
      retries: 0,
    });

    ensureSorobanServer(RPC_1).simulateTransaction.mockRejectedValue(
      new RpcError("Service Unavailable", { status: 503 }),
    );
    ensureSorobanServer(RPC_2).simulateTransaction.mockResolvedValue({
      result: {
        retval: {
          pubkey: new Uint8Array([0xab, 0xcd]),
          credential_types: ["kyc"],
          revoked: false,
        },
      },
    });

    const issuer = await getIssuer(WALLET, { withMetadata: false });
    expect(issuer).toEqual({
      id: WALLET,
      revoked: false,
      credentialTypes: ["kyc"],
      pubkeyHex: "abcd",
    });
    expect(ensureSorobanServer(RPC_1).simulateTransaction).toHaveBeenCalledTimes(1);
    expect(ensureSorobanServer(RPC_2).simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("executeWithRpcFailover throws RpcError when every node fails", async () => {
    configure({
      rpcUrls: [RPC_1, RPC_2],
    });

    await expect(
      executeWithRpcFailover(async (url) => {
        throw new RpcError(`down: ${url}`, { status: 503 });
      }),
    ).rejects.toThrow(`down: ${RPC_2}`);
  });
});
