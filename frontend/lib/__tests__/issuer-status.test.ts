// @vitest-environment jsdom
//
// Tests for checkIssuerStatus (lib/issuer-registry.ts) — issue #626.
//
// checkIssuerStatus drives two Soroban simulations: is_valid_issuer and
// is_valid_issuer_key. The whole stellar-sdk and the network are mocked so
// the tests run offline. Only the branching logic under test is exercised.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockGetAccount, mockSimulateTransaction, mockScValToNative } = vi.hoisted(
  () => ({
    mockGetAccount: vi.fn(),
    mockSimulateTransaction: vi.fn(),
    mockScValToNative: vi.fn((v: unknown) => v),
  }),
);

// ── Mock @stellar/stellar-sdk ─────────────────────────────────────────────────
// The simulate() helper inside issuer-registry.ts dynamically imports this.
// We stub out just the RPC layer; everything else (xdr, scvBytes) is simple
// enough to stub inline.

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...((actual as Record<string, unknown>).rpc as Record<string, unknown>),
      Server: vi.fn().mockImplementation(() => ({
        getAccount: mockGetAccount,
        simulateTransaction: mockSimulateTransaction,
      })),
      Api: {
        isSimulationError: (sim: unknown) =>
          typeof sim === "object" && sim !== null && "error" in sim,
      },
    },
    TransactionBuilder: vi.fn().mockImplementation(() => ({
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({}),
    })),
    BASE_FEE: "100",
    scValToNative: mockScValToNative,
    nativeToScVal: vi.fn((v: unknown) => v),
    Contract: vi.fn().mockImplementation(() => ({
      call: vi.fn((_method: string, ...args: unknown[]) => ({ method: _method, args })),
    })),
    Address: {
      fromString: vi.fn((s: string) => ({ toScVal: () => ({ address: s }) })),
    },
    xdr: {
      ScVal: {
        scvBytes: vi.fn((b: unknown) => ({ type: "bytes", value: b })),
      },
    },
  };
});

// ── Mock lib/stellar so CONTRACTS.issuerRegistry is populated ────────────────

vi.mock("../stellar", () => ({
  CONTRACTS: {
    issuerRegistry: "CISSUER0000000000000000000000000000000000000000000000000000",
    proofRegistry: "CPROOF000000000000000000000000000000000000000000000000000000",
    credentialVerifier: "",
    gatedPool: "",
  },
  RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  NETWORK: "testnet",
}));

import { checkIssuerStatus } from "../issuer-registry";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const SIM_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ISSUER_ID = "GISSUER0000000000000000000000000000000000000000000000000001";
const PUB_X = Array<number>(32).fill(0x01);
const PUB_Y = Array<number>(32).fill(0x02);

/**
 * Queue one simulated RPC response. The mock scValToNative just returns
 * whatever retval we pass in, so we make the simulation return `{ result:
 * { retval } }` and scValToNative returns it directly.
 */
function queueSim(retval: unknown) {
  mockGetAccount.mockResolvedValueOnce({ id: SIM_ACCOUNT, sequence: "0" });
  mockScValToNative.mockReturnValueOnce(retval);
  mockSimulateTransaction.mockResolvedValueOnce({ result: { retval } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkIssuerStatus", () => {
  it("returns 'active' when issuer is valid and key is valid", async () => {
    queueSim(true);  // is_valid_issuer → true
    queueSim(true);  // is_valid_issuer_key → true

    const status = await checkIssuerStatus(ISSUER_ID, "kyc", PUB_X, PUB_Y, SIM_ACCOUNT);
    expect(status).toBe("active");
  });

  it("returns 'key_retired' when issuer is valid but credential key is no longer accepted", async () => {
    queueSim(true);   // is_valid_issuer → true
    queueSim(false);  // is_valid_issuer_key → false

    const status = await checkIssuerStatus(ISSUER_ID, "kyc", PUB_X, PUB_Y, SIM_ACCOUNT);
    expect(status).toBe("key_retired");
  });

  it("returns 'issuer_revoked' when get_issuer shows revoked:true", async () => {
    queueSim(false);  // is_valid_issuer → false
    // get_issuer → OnChainIssuer with revoked: true
    queueSim({ pubkey: new Uint8Array(64), credential_types: ["kyc"], revoked: true });

    const status = await checkIssuerStatus(ISSUER_ID, "kyc", PUB_X, PUB_Y, SIM_ACCOUNT);
    expect(status).toBe("issuer_revoked");
  });

  it("returns 'key_revoked' when is_valid_issuer is false but issuer is not revoked", async () => {
    queueSim(false);  // is_valid_issuer → false (current key was emergency-revoked)
    // get_issuer → issuer exists but revoked: false
    queueSim({ pubkey: new Uint8Array(64), credential_types: ["kyc"], revoked: false });

    const status = await checkIssuerStatus(ISSUER_ID, "kyc", PUB_X, PUB_Y, SIM_ACCOUNT);
    expect(status).toBe("key_revoked");
  });

  it("returns 'unknown' when the first simulation throws", async () => {
    mockGetAccount.mockRejectedValueOnce(new Error("network error"));

    const status = await checkIssuerStatus(ISSUER_ID, "kyc", PUB_X, PUB_Y, SIM_ACCOUNT);
    expect(status).toBe("unknown");
  });

  it("returns 'active' when pubkey arrays are wrong length — skips key check", async () => {
    queueSim(true);  // is_valid_issuer → true; no key check follows

    const status = await checkIssuerStatus(ISSUER_ID, "kyc", [], [], SIM_ACCOUNT);
    expect(status).toBe("active");
    // Only one simulation call (is_valid_issuer); key check skipped.
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 'unknown' when is_valid_issuer returns null (simulation error)", async () => {
    // Simulate a simulation error response (no result).
    mockGetAccount.mockResolvedValueOnce({ id: SIM_ACCOUNT, sequence: "0" });
    mockScValToNative.mockReturnValueOnce(null);
    mockSimulateTransaction.mockResolvedValueOnce({ result: null });

    const status = await checkIssuerStatus(ISSUER_ID, "kyc", PUB_X, PUB_Y, SIM_ACCOUNT);
    expect(status).toBe("unknown");
  });
});
