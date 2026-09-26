import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isVerified = vi.fn();
const checkClaim = vi.fn();

vi.mock("../../proof-registry/src/index", () => ({
  Client: vi.fn(function ProofRegistryClient() {
    return {
      is_verified: isVerified,
      check_claim: checkClaim,
    };
  }),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {},
  StrKey: {
    isValidEd25519PublicKey: vi.fn(
      (address: string) => address === "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    ),
  },
}));

import {
  configure,
  hasClaim,
  getClaims,
  verifyPreset,
  ConfigError,
  InvalidAddressError,
  RpcError,
  TimeoutError,
  StellarCred,
  withRetry,
  __resetBoundaryWarningForTesting,
} from "./index";
import { hasClaim as sharedHasClaim } from "./claims";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

describe("error taxonomy exports", () => {
  it("exports ConfigError, RpcError, and TimeoutError on the namespace", () => {
    expect(StellarCred.ConfigError).toBe(ConfigError);
    expect(StellarCred.RpcError).toBe(RpcError);
    expect(StellarCred.TimeoutError).toBe(TimeoutError);
    expect(StellarCred.InvalidAddressError).toBe(InvalidAddressError);
    expect(new ConfigError().name).toBe("ConfigError");
    expect(new RpcError().name).toBe("RpcError");
    expect(new InvalidAddressError().name).toBe("InvalidAddressError");
  });
});

describe("hasClaim — address validation", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({ registryId: "C_TEST_REGISTRY" });
  });

  it("returns false for an invalid Stellar address without making an RPC call", async () => {
    await expect(hasClaim("invalid-address", "kyc")).resolves.toBe(false);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("returns false for an empty address without making an RPC call", async () => {
    await expect(hasClaim("", "kyc")).resolves.toBe(false);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("returns false for a whitespace-only address without making an RPC call", async () => {
    await expect(hasClaim("   ", "kyc")).resolves.toBe(false);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("trims a valid Stellar address before making the RPC call", async () => {
    isVerified.mockResolvedValue({
      result: [true, 1_700_000_000n, 1_800_000_000n],
    });

    await expect(hasClaim(`  ${WALLET}  `, "kyc")).resolves.toBe(true);

    expect(isVerified).toHaveBeenCalledTimes(1);
    expect(isVerified).toHaveBeenCalledWith({
      holder: WALLET,
      credential_type: "kyc",
      trusted_issuers: undefined,
    });
  });

  it("throws InvalidAddressError for an invalid address when throwOnError is enabled", async () => {
    await expect(
      hasClaim("invalid-address", "kyc", { throwOnError: true }),
    ).rejects.toBeInstanceOf(InvalidAddressError);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("does not make an RPC call for an invalid threshold claim", async () => {
    await expect(
      hasClaim("invalid-address", "age", { minThreshold: 21 }),
    ).resolves.toBe(false);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
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

describe("read request timeout", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({
      registryId: "C_TEST_REGISTRY",
      requestTimeoutMs: 25,
      retries: 0,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when is_verified never settles", async () => {
    isVerified.mockImplementation(() => new Promise(() => {}));

    const result = hasClaim(WALLET, "kyc");
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBe(false);
  });

  it("applies the configured timeout to shared framework reads", async () => {
    vi.useRealTimers();
    isVerified.mockImplementation(() => new Promise(() => {}));

    await expect(sharedHasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("returns false when check_claim never settles", async () => {
    checkClaim.mockImplementation(() => new Promise(() => {}));

    const result = hasClaim(WALLET, "age", { minThreshold: 21 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toBe(false);
  });

  it("returns an empty list when getClaims reads never settle", async () => {
    isVerified.mockImplementation(() => new Promise(() => {}));

    const result = getClaims(WALLET);
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual([]);
    expect(isVerified).toHaveBeenCalledTimes(6);
  });

  it("preserves RpcError when a timed out read opts into errors", async () => {
    isVerified.mockImplementation(() => new Promise(() => {}));

    const result = hasClaim(WALLET, "kyc", {
      requestTimeoutMs: 25,
      throwOnError: true,
    });
    const assertion = expect(result).rejects.toBeInstanceOf(RpcError);
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
  });
});

describe("getClaims — address validation", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({ registryId: "C_TEST_REGISTRY" });
  });

  it("returns an empty list for an invalid address without making RPC calls", async () => {
    await expect(getClaims("invalid-address")).resolves.toEqual([]);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("returns an empty list for an empty address without making RPC calls", async () => {
    await expect(getClaims("")).resolves.toEqual([]);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
  });

  it("throws InvalidAddressError when getClaims receives an invalid address and throwOnError is enabled", async () => {
    await expect(
      getClaims("invalid-address", { throwOnError: true }),
    ).rejects.toBeInstanceOf(InvalidAddressError);

    expect(isVerified).not.toHaveBeenCalled();
    expect(checkClaim).not.toHaveBeenCalled();
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

// ── verifyPreset (#386) ──────────────────────────────────────────────────────

describe("verifyPreset", () => {
  beforeEach(() => {
    isVerified.mockReset();
    checkClaim.mockReset();
    configure({ registryId: "C_TEST_REGISTRY" });
  });

  it("is allValid when every claim in the preset passes", async () => {
    isVerified.mockResolvedValue({ result: [true, 1_700_000_000n, 1_800_000_000n] });

    const { allValid, results } = await verifyPreset(WALLET, [
      { type: "kyc" },
      { type: "jurisdiction" },
    ]);

    expect(allValid).toBe(true);
    expect(results).toEqual({ kyc: true, jurisdiction: true });
  });

  it("is not allValid when any single claim fails, but still reports every result", async () => {
    isVerified.mockImplementation(async ({ credential_type }: { credential_type: string }) => ({
      result: [credential_type === "kyc", 1_700_000_000n, 1_800_000_000n],
    }));

    const { allValid, results } = await verifyPreset(WALLET, [
      { type: "kyc" },
      { type: "jurisdiction" },
    ]);

    expect(allValid).toBe(false);
    expect(results).toEqual({ kyc: true, jurisdiction: false });
  });

  it("routes a thresholded claim through check_claim with the preset's minThreshold", async () => {
    checkClaim.mockResolvedValue({ result: true });

    const { allValid } = await verifyPreset(WALLET, [
      { type: "accreditation", minThreshold: 1_000_000 },
    ]);

    expect(allValid).toBe(true);
    expect(checkClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        credential_type: "accreditation",
        min_threshold: 1_000_000n,
      }),
    );
  });

  it("is not allValid for an empty preset", async () => {
    const { allValid, results } = await verifyPreset(WALLET, []);
    expect(allValid).toBe(false);
    expect(results).toEqual({});
    expect(isVerified).not.toHaveBeenCalled();
  });

  it("is exported on the StellarCred namespace", () => {
    expect(StellarCred.verifyPreset).toBe(verifyPreset);
  });
});

// ── Client/server boundary warning (Issue #535) ─────────────────────────────

describe("warnOnClientServerBoundaryViolation", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Reset the one-shot flag before every test so each case starts fresh.
    __resetBoundaryWarningForTesting();
    // Ensure no leaked env vars linger from a previous test.
    delete (process.env as Record<string, string | undefined>)["STELLARCRED_REGISTRY_ID"];
    delete (process.env as Record<string, string | undefined>)["PROOF_REGISTRY_ID"];
    delete (process.env as Record<string, string | undefined>)["STELLARCRED_RPC_URL"];
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    __resetBoundaryWarningForTesting();
    // Clean up any injected globals or env vars.
    delete (globalThis as Record<string, unknown>).window;
    delete (process.env as Record<string, string | undefined>)["STELLARCRED_REGISTRY_ID"];
    delete (process.env as Record<string, string | undefined>)["PROOF_REGISTRY_ID"];
    delete (process.env as Record<string, string | undefined>)["STELLARCRED_RPC_URL"];
  });

  it("does NOT warn in a non-browser (Node.js) context even with server-only env vars", () => {
    // In vitest/Node, `window` is not defined — simulates a real Node.js environment.
    // Ensure window is absent.
    delete (globalThis as Record<string, unknown>).window;
    process.env["STELLARCRED_REGISTRY_ID"] = "C_SERVER_REGISTRY";

    configure({ registryId: "C_SERVER_REGISTRY" });

    // No boundary warning should fire — we're in Node, not a browser.
    const boundaryWarnings = consoleWarnSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("[StellarCred]") && msg.includes("server-only"),
    );
    expect(boundaryWarnings).toHaveLength(0);
  });

  it("warns in a browser context when a leaked STELLARCRED_* env var is visible in process.env", () => {
    // Simulate browser context by setting window on globalThis.
    (globalThis as Record<string, unknown>).window = {};
    // Simulate a leaked server-only env var visible in process.env.
    process.env["STELLARCRED_REGISTRY_ID"] = "C_LEAKED_REGISTRY";

    configure({ registryId: "C_LEAKED_REGISTRY" });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[StellarCred]"),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("server-only environment variables"),
    );
  });

  it("warns in a browser context when configure() is called with a PROOF_REGISTRY_ID server env value", () => {
    (globalThis as Record<string, unknown>).window = {};
    process.env["PROOF_REGISTRY_ID"] = "C_SERVER_ONLY_ID";

    // Simulate the integrator mistake: using the server-only var value in configure().
    configure({ registryId: process.env["PROOF_REGISTRY_ID"] });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[StellarCred]"),
    );
  });

  it("does NOT warn in a browser context when no suspicious env indicators are present", () => {
    (globalThis as Record<string, unknown>).window = {};
    // Ensure no leaked vars exist.
    delete (process.env as Record<string, string | undefined>)["STELLARCRED_REGISTRY_ID"];
    delete (process.env as Record<string, string | undefined>)["PROOF_REGISTRY_ID"];

    // Use a fresh value not in process.env.
    configure({ registryId: "C_FRESH_PUBLIC_REGISTRY_ID_NOT_IN_ENV" });

    const boundaryWarnings = consoleWarnSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("[StellarCred]") && msg.includes("server-only"),
    );
    expect(boundaryWarnings).toHaveLength(0);
  });

  it("warns at most once per load even if configure() is called multiple times", () => {
    (globalThis as Record<string, unknown>).window = {};
    process.env["STELLARCRED_REGISTRY_ID"] = "C_LEAKED";

    configure({ registryId: "C_LEAKED" });
    configure({ registryId: "C_LEAKED" });
    configure({ registryId: "C_LEAKED" });

    const boundaryWarnings = consoleWarnSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("[StellarCred]") && msg.includes("server-only"),
    );
    expect(boundaryWarnings).toHaveLength(1);
  });

  it("does NOT warn when NODE_ENV is 'production'", () => {
    (globalThis as Record<string, unknown>).window = {};
    process.env["STELLARCRED_REGISTRY_ID"] = "C_LEAKED_PROD";
    const origNodeEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";

    try {
      configure({ registryId: "C_LEAKED_PROD" });

      const boundaryWarnings = consoleWarnSpy.mock.calls.filter(([msg]) =>
        typeof msg === "string" && msg.includes("[StellarCred]") && msg.includes("server-only"),
      );
      expect(boundaryWarnings).toHaveLength(0);
    } finally {
      process.env["NODE_ENV"] = origNodeEnv;
    }
  });
});