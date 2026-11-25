import { beforeEach, describe, it, expect, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  getAccount: vi.fn(),
  prepareTransaction: vi.fn(),
  sendTransaction: vi.fn(),
  getTransaction: vi.fn(),
}));

vi.mock("../wallet", () => ({ signTx: vi.fn() }));
vi.mock("../stellar", () => ({
  RPC_URL: "https://rpc.example.test",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  CONTRACTS: { proofRegistry: "" },
}));
vi.mock("@stellar/stellar-sdk", () => {
  class TransactionBuilder {
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return {};
    }
    static fromXDR() {
      return {};
    }
  }
  class Address {
    static fromString() {
      return { toScVal: () => ({}) };
    }
  }
  const ScVal = new Proxy({}, { get: () => () => ({}) });
  return {
    rpc: {
      Server: class {
        getAccount = rpc.getAccount;
        prepareTransaction = rpc.prepareTransaction;
        sendTransaction = rpc.sendTransaction;
        getTransaction = rpc.getTransaction;
      },
    },
    Contract: class {
      call() {
        return {};
      }
    },
    TransactionBuilder,
    Address,
    ScVal,
    xdr: { ScVal, ScMapEntry: class {} },
    nativeToScVal: () => ({}),
    BASE_FEE: "100",
  };
});

import { signTx } from "../wallet";
import { CONTRACTS } from "../stellar";
import { MAX_BATCH_SIZE, submitProofs, type ProofSubmissionParams } from "../contracts";

// These guards run before any wallet or RPC work, so they can be exercised
// without a configured registry or a connected wallet.

const submission = (credentialType: string): ProofSubmissionParams => ({
  issuerId: "GISSUER",
  credentialType,
  proof: new Uint8Array([1, 2, 3]),
  publicInputs: new Uint8Array([4, 5, 6, 7]),
  ttlSecs: 3600,
});

const submit = (types: string[]) =>
  submitProofs({ holder: "GHOLDER", submissions: types.map(submission) });

beforeEach(() => {
  vi.clearAllMocks();
  CONTRACTS.proofRegistry = "";
  rpc.getAccount.mockResolvedValue({ sequenceNumber: "0" });
  rpc.prepareTransaction.mockResolvedValue({ fee: "100", toXDR: () => "prepared" });
  vi.mocked(signTx).mockResolvedValue("signed");
  rpc.sendTransaction.mockResolvedValue({ status: "SUCCESS", hash: "transaction-hash" });
  rpc.getTransaction.mockResolvedValue({ status: "SUCCESS" });
});

describe("submitProofs pre-flight limits", () => {
  it("mirrors the contract's MAX_BATCH_SIZE", () => {
    expect(MAX_BATCH_SIZE).toBe(5);
  });

  it("rejects an empty batch with the contract diagnostic code", async () => {
    await expect(submit([])).rejects.toMatchObject({
      name: "VerificationError",
      code: 8,
      category: "invalid_input",
    });
  });

  it("rejects more than MAX_BATCH_SIZE proofs", async () => {
    const types = ["kyc", "age", "income", "funds", "accreditation", "jurisdiction"];
    expect(types.length).toBeGreaterThan(MAX_BATCH_SIZE);
    await expect(submit(types)).rejects.toMatchObject({
      name: "VerificationError",
      code: 7,
      category: "invalid_input",
    });
  });

  it("rejects two proofs of the same credential type without echoing it", async () => {
    const error = await submit(["age", "kyc", "age"]).catch((caught) => caught);
    expect(error).toMatchObject({ code: 9, category: "invalid_input" });
    expect(error.message).not.toContain("age");
  });

  it("lets a full batch of distinct types through to the registry check", async () => {
    // No registry id is configured under test, so a batch that passes every
    // pre-flight check fails at the next step — which is what proves it passed.
    await expect(submit(["kyc", "age", "income", "funds", "accreditation"])).rejects.toThrow(
      /ProofRegistry contract id not set/,
    );
  });
});

describe("submitProofs error boundaries", () => {
  beforeEach(() => {
    CONTRACTS.proofRegistry = "CREGISTRY";
  });

  it("normalizes account lookup failures without exposing RPC exception text", async () => {
    const secret = "credential=private salt=secret signature=secret witness=[secret]";
    rpc.getAccount.mockRejectedValue(new Error(secret));

    const error = await submit(["kyc"]).catch((caught) => caught);

    expect(error).toMatchObject({
      name: "VerificationError",
      category: "network_error",
      code: "rpc_unavailable",
      retryable: true,
    });
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("private");
  });

  it("normalizes wallet signing failures without exposing provider exception text", async () => {
    const secret = "credential=private salt=secret signature=secret witness=[secret]";
    vi.mocked(signTx).mockRejectedValue(new Error(secret));

    const error = await submit(["kyc"]).catch((caught) => caught);

    expect(error).toMatchObject({
      name: "VerificationError",
      category: "authorization_error",
      code: "wallet_authorization",
      retryable: false,
    });
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("private");
  });
});
