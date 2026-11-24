import { describe, expect, it } from "vitest";
import {
  ContractError,
  ContractErrorCode,
  parseContractError,
  PROOF_REGISTRY_ERROR_MESSAGES,
  RpcError,
} from "../src/errors";

describe("ContractError", () => {
  it("creates a typed error with code and friendly message", () => {
    const error = new ContractError(
      ContractErrorCode.IssuerNotTrusted,
      PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.IssuerNotTrusted],
      "Error(Contract, #4)",
    );

    expect(error.name).toBe("ContractError");
    expect(error.code).toBe(4);
    expect(error.friendlyMessage).toContain("Issuer not trusted");
    expect(error.raw).toBe("Error(Contract, #4)");
    expect(error.message).toBe(error.friendlyMessage);
  });

  describe("isRetryable", () => {
    it("returns true for SubmissionsPaused", () => {
      const error = new ContractError(
        ContractErrorCode.SubmissionsPaused,
        PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.SubmissionsPaused],
        "Error(Contract, #11)",
      );
      expect(error.isRetryable()).toBe(true);
    });

    it("returns false for terminal errors", () => {
      const error = new ContractError(
        ContractErrorCode.IssuerNotTrusted,
        PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.IssuerNotTrusted],
        "Error(Contract, #4)",
      );
      expect(error.isRetryable()).toBe(false);
    });
  });

  describe("isTerminal", () => {
    it("returns true for VerificationFailed", () => {
      const error = new ContractError(
        ContractErrorCode.VerificationFailed,
        PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.VerificationFailed],
        "Error(Contract, #2)",
      );
      expect(error.isTerminal()).toBe(true);
    });

    it("returns true for IssuerNotTrusted", () => {
      const error = new ContractError(
        ContractErrorCode.IssuerNotTrusted,
        PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.IssuerNotTrusted],
        "Error(Contract, #4)",
      );
      expect(error.isTerminal()).toBe(true);
    });

    it("returns true for IssuerKeyMismatch", () => {
      const error = new ContractError(
        ContractErrorCode.IssuerKeyMismatch,
        PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.IssuerKeyMismatch],
        "Error(Contract, #5)",
      );
      expect(error.isTerminal()).toBe(true);
    });

    it("returns false for retryable errors", () => {
      const error = new ContractError(
        ContractErrorCode.BatchTooLarge,
        PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.BatchTooLarge],
        "Error(Contract, #7)",
      );
      expect(error.isTerminal()).toBe(false);
    });
  });
});

describe("parseContractError", () => {
  it("parses Error(Contract, #N) format", () => {
    const error = parseContractError("Error(Contract, #4)");
    expect(error).not.toBeNull();
    expect(error?.code).toBe(4);
    expect(error?.friendlyMessage).toContain("Issuer not trusted");
    expect(error?.raw).toBe("Error(Contract, #4)");
  });

  it("parses ContractError(N) format", () => {
    const error = parseContractError("ContractError(4)");
    expect(error).not.toBeNull();
    expect(error?.code).toBe(4);
    expect(error?.friendlyMessage).toContain("Issuer not trusted");
  });

  it("parses ContractError(Some(N)) format", () => {
    const error = parseContractError("ContractError(Some(4))");
    expect(error).not.toBeNull();
    expect(error?.code).toBe(4);
    expect(error?.friendlyMessage).toContain("Issuer not trusted");
  });

  it("returns null for unrecognized error format", () => {
    const error = parseContractError("Something went wrong");
    expect(error).toBeNull();
  });

  it("returns null for empty string", () => {
    const error = parseContractError("");
    expect(error).toBeNull();
  });

  it("uses fallback message for unknown error codes", () => {
    const error = parseContractError("Error(Contract, #999)");
    expect(error).not.toBeNull();
    expect(error?.code).toBe(999);
    expect(error?.friendlyMessage).toBe("Contract error #999.");
  });
});

describe("ContractErrorCode constants", () => {
  it("exports all contract error codes", () => {
    expect(ContractErrorCode.NotInitialized).toBe(1);
    expect(ContractErrorCode.VerificationFailed).toBe(2);
    expect(ContractErrorCode.NotAuthorized).toBe(3);
    expect(ContractErrorCode.IssuerNotTrusted).toBe(4);
    expect(ContractErrorCode.IssuerKeyMismatch).toBe(5);
    expect(ContractErrorCode.ProofNotFound).toBe(6);
    expect(ContractErrorCode.BatchTooLarge).toBe(7);
    expect(ContractErrorCode.BatchEmpty).toBe(8);
    expect(ContractErrorCode.DuplicateCredentialType).toBe(9);
    expect(ContractErrorCode.AggregateLayoutInvalid).toBe(10);
    expect(ContractErrorCode.SubmissionsPaused).toBe(11);
    expect(ContractErrorCode.InvalidExpiry).toBe(12);
  });
});

describe("PROOF_REGISTRY_ERROR_MESSAGES", () => {
  it("has messages for all error codes", () => {
    for (let code = 1; code <= 12; code++) {
      expect(PROOF_REGISTRY_ERROR_MESSAGES[code]).toBeDefined();
      expect(typeof PROOF_REGISTRY_ERROR_MESSAGES[code]).toBe("string");
      expect(PROOF_REGISTRY_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  it("messages match expected content", () => {
    expect(PROOF_REGISTRY_ERROR_MESSAGES[1]).toContain("not initialised");
    expect(PROOF_REGISTRY_ERROR_MESSAGES[2]).toContain("verification failed");
    expect(PROOF_REGISTRY_ERROR_MESSAGES[3]).toContain("Not authorised");
    expect(PROOF_REGISTRY_ERROR_MESSAGES[4]).toContain("not trusted");
    expect(PROOF_REGISTRY_ERROR_MESSAGES[5]).toContain("key mismatch");
    expect(PROOF_REGISTRY_ERROR_MESSAGES[11]).toContain("paused");
  });
});

describe("RpcError", () => {
  it("creates an RPC error without contract error", () => {
    const error = new RpcError("Network timeout", { status: 504 });
    expect(error.name).toBe("RpcError");
    expect(error.message).toBe("Network timeout");
    expect(error.status).toBe(504);
    expect(error.isContractError()).toBe(false);
  });

  it("creates an RPC error wrapping a contract error", () => {
    const contractError = new ContractError(
      ContractErrorCode.IssuerNotTrusted,
      PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.IssuerNotTrusted],
      "Error(Contract, #4)",
    );
    const error = new RpcError("Transaction failed", { contractError });
    expect(error.isContractError()).toBe(true);
    expect(error.contractError).toBe(contractError);
    expect(error.contractError?.code).toBe(4);
  });

  it("carries cause for debugging", () => {
    const cause = new Error("Network unreachable");
    const error = new RpcError("RPC request failed", { cause });
    expect(error.cause).toBe(cause);
  });
});

describe("Error type discrimination", () => {
  it("allows switching on error types", () => {
    const errors = [
      new ContractError(4, "Issuer not trusted", "Error(Contract, #4)"),
      new RpcError("Network timeout"),
      new Error("Generic error"),
    ];

    const classified = errors.map((err) => {
      if (err instanceof ContractError) {
        return `contract:${err.code}`;
      } else if (err instanceof RpcError) {
        return "rpc";
      } else {
        return "generic";
      }
    });

    expect(classified).toEqual(["contract:4", "rpc", "generic"]);
  });

  it("allows branching on contract error codes", () => {
    const error = new ContractError(
      ContractErrorCode.IssuerNotTrusted,
      PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.IssuerNotTrusted],
      "Error(Contract, #4)",
    );

    let action = "";
    if (error.code === ContractErrorCode.IssuerNotTrusted) {
      action = "show_issuer_registration_ui";
    } else if (error.code === ContractErrorCode.VerificationFailed) {
      action = "show_proof_invalid_ui";
    }

    expect(action).toBe("show_issuer_registration_ui");
  });
});
