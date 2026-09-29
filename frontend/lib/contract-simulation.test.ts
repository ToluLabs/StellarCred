// Coverage for the tri-state read path in lib/contract-simulation.ts
// (Issue #634 — a failed read must render as "unknown", never as "unverified").
//
// The SDK is reached through a dynamic import, so it is mocked wholesale here:
// the tests care about what the app does with a thrown transport error, a
// simulation error, and a successful read.

import { describe, it, expect, beforeEach, vi } from "vitest";

const getAccount = vi.fn();
const simulateTransaction = vi.fn();

vi.mock("@stellar/stellar-sdk", () => {
  class Server {
    getAccount = getAccount;
    simulateTransaction = simulateTransaction;
  }
  class Contract {
    call = vi.fn(() => ({}));
  }
  class TransactionBuilder {
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return { op: "tx" };
    }
  }
  return {
    rpc: {
      Server,
      // Mirrors rpc.Api.isSimulationError: an object with an `error` is one.
      Api: { isSimulationError: (sim: unknown) => Boolean((sim as { error?: unknown })?.error) },
    },
    Contract,
    TransactionBuilder,
    Address: { fromString: (s: string) => ({ toScVal: () => ({ addr: s }) }) },
    nativeToScVal: (v: unknown) => v,
    scValToNative: (v: unknown) => v,
    xdr: { ScVal: { scvVec: (v: unknown) => v } },
    BASE_FEE: "100",
  };
});

const REGISTRY = "CBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4Y2";

async function loadModule(opts: { registryId?: string } = {}) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID = opts.registryId ?? REGISTRY;
  vi.stubEnv("NEXT_PUBLIC_PROOF_REGISTRY_ID", opts.registryId ?? REGISTRY);
  return import("./contract-simulation");
}

beforeEach(() => {
  getAccount.mockReset();
  simulateTransaction.mockReset();
});

describe("checkClaim", () => {
  it("reports a proved claim as verified", async () => {
    getAccount.mockResolvedValue({ id: "holder" });
    simulateTransaction.mockResolvedValue({ result: { retval: true } });
    const { checkClaim } = await loadModule();

    await expect(checkClaim("GABC", "kyc")).resolves.toEqual({
      status: "verified",
      proved: true,
    });
  });

  it("reports a real negative as unverified, not unknown", async () => {
    getAccount.mockResolvedValue({ id: "holder" });
    simulateTransaction.mockResolvedValue({ result: { retval: false } });
    const { checkClaim } = await loadModule();

    await expect(checkClaim("GABC", "kyc")).resolves.toEqual({
      status: "unverified",
      proved: false,
    });
  });

  it("returns unknown when the RPC endpoint cannot be reached", async () => {
    getAccount.mockRejectedValue(new Error("Failed to fetch"));
    const { checkClaim } = await loadModule();

    const result = await checkClaim("GABC", "kyc");
    expect(result.status).toBe("unknown");
    expect(result.status === "unknown" && result.issue.kind).toBe("rpc-unreachable");
    // The dangerous shape: a failed read must never carry `proved: false`.
    expect(result.status === "unknown" && result.proved).toBeUndefined();
  });

  it("returns unknown when the simulation produced no result", async () => {
    getAccount.mockResolvedValue({ id: "holder" });
    simulateTransaction.mockResolvedValue({ error: { status: 500, statusCode: 500 } });
    const { checkClaim } = await loadModule();

    const result = await checkClaim("GABC", "kyc");
    expect(result.status).toBe("unknown");
  });

  it("treats a holder with no account as genuinely unverified", async () => {
    getAccount.mockRejectedValue(new Error("Account not found"));
    const { checkClaim } = await loadModule();

    await expect(checkClaim("GABC", "kyc")).resolves.toEqual({
      status: "unverified",
      proved: false,
    });
  });

  it("returns unknown when no ProofRegistry is configured", async () => {
    const { checkClaim } = await loadModule({ registryId: "" });

    const result = await checkClaim("GABC", "kyc");
    expect(result.status).toBe("unknown");
    expect(result.status === "unknown" && result.issue.kind).toBe("not-configured");
  });
});

describe("isVerified", () => {
  it("returns the on-chain record for a valid proof", async () => {
    getAccount.mockResolvedValue({ id: "holder" });
    simulateTransaction.mockResolvedValue({ result: { retval: [true, 1_700_000_000, 1_800_000_000] } });
    const { isVerified } = await loadModule();

    await expect(isVerified("GABC", "kyc")).resolves.toEqual({
      status: "verified",
      valid: true,
      verifiedAt: 1_700_000_000,
      expiry: 1_800_000_000,
    });
  });

  it("returns unknown — with no `valid` field — when the read fails", async () => {
    getAccount.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8000"));
    const { isVerified } = await loadModule();

    const result = await isVerified("GABC", "kyc");
    expect(result.status).toBe("unknown");
    // A caller that only reads `result.valid` cannot get a false negative here.
    expect(result.status === "unknown" && result.valid).toBeUndefined();
    expect(result.status === "unknown" && result.issue.kind).toBe("rpc-unreachable");
  });
});

describe("health reporting", () => {
  it("flips the shared health state to degraded on a failed read", async () => {
    getAccount.mockRejectedValue(new Error("Failed to fetch"));
    const { checkClaim } = await loadModule();
    const { getRpcHealth } = await import("./rpc-health");

    await checkClaim("GABC", "kyc");
    expect(getRpcHealth().status).toBe("degraded");
  });

  it("clears the degraded state on a successful read", async () => {
    const { checkClaim } = await loadModule();
    const { getRpcHealth, reportRpcIssue } = await import("./rpc-health");

    reportRpcIssue({ kind: "rpc-unreachable", message: "node down" });
    getAccount.mockResolvedValue({ id: "holder" });
    simulateTransaction.mockResolvedValue({ result: { retval: true } });

    await checkClaim("GABC", "kyc");
    expect(getRpcHealth().status).toBe("ok");
  });
});
