import { describe, expect, it } from "vitest";
import {
  ContractError,
  ContractErrorCode,
  parseContractError,
  PROOF_REGISTRY_ERROR_MESSAGES,
  RpcError,
  VerificationError,
  classifyVerificationError,
  verificationErrorFromApi,
  TransactionSubmissionError,
} from "../src/errors";
import { ConfigError } from "../src/claims";

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
    expect(ContractErrorCode.RoleNotHeld).toBe(13);
    expect(ContractErrorCode.RoleHolderMismatch).toBe(14);
    expect(ContractErrorCode.NoPendingAdmin).toBe(15);
    expect(ContractErrorCode.NullifierAlreadyUsed).toBe(16);
  });
});

describe("PROOF_REGISTRY_ERROR_MESSAGES", () => {
  it("has messages for all error codes", () => {
    for (let code = 1; code <= 16; code++) {
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

describe("safe verification error taxonomy", () => {
  it("maps contract policy rejection and invalid expiry to distinct categories", () => {
    const policy = classifyVerificationError(
      new ContractError(4, PROOF_REGISTRY_ERROR_MESSAGES[4], "Error(Contract, #4)"),
    );
    const expired = classifyVerificationError(
      new ContractError(12, PROOF_REGISTRY_ERROR_MESSAGES[12], "Error(Contract, #12)"),
    );

    expect(policy).toMatchObject({ category: "policy_rejection", code: 4, retryable: false });
    expect(expired).toMatchObject({ category: "invalid_input", code: 12, retryable: false });
  });

  it("treats paused submissions as a retryable policy rejection", () => {
    const paused = classifyVerificationError(
      new ContractError(11, PROOF_REGISTRY_ERROR_MESSAGES[11], "Error(Contract, #11)"),
    );
    expect(paused).toMatchObject({ category: "policy_rejection", code: 11, retryable: true });
  });

  it("distinguishes unsupported credentials, configuration, authorization, and network failures", () => {
    expect(
      classifyVerificationError({ name: "CircuitVersionMismatchError", message: "v1 != v2" }),
    ).toMatchObject({ category: "unsupported_credential", code: "circuit_version_mismatch" });
    expect(classifyVerificationError(new ConfigError("missing secret value"))).toMatchObject({
      category: "configuration_error",
      code: "configuration_error",
    });
    expect(
      classifyVerificationError({ name: "Error", message: "Error(Auth, BadAuth)" }),
    ).toMatchObject({ category: "authorization_error", code: "wallet_authorization" });
    expect(
      classifyVerificationError(new RpcError("private transport detail", { status: 503 })),
    ).toMatchObject({ category: "network_error", code: 503, retryable: true, httpStatus: 503 });
  });

  it("preserves API diagnostic codes without exposing response text", () => {
    const secret = "salt=super-private signature=abc123 witness=[1,2,3]";
    const error = verificationErrorFromApi(400, {
      code: "invalid_credential",
      category: "invalid_input",
      error: secret,
    });

    expect(error).toMatchObject({
      category: "invalid_input",
      code: "invalid_credential",
      httpStatus: 400,
      retryable: false,
    });
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("super-private");
  });

  it("classifies known API transport codes even when the HTTP status is misleading", () => {
    expect(
      verificationErrorFromApi(400, { code: "indexer_unavailable", error: "private detail" }),
    ).toMatchObject({ category: "network_error", code: "indexer_unavailable", retryable: true });
    expect(
      verificationErrorFromApi(200, { code: "persona_not_configured", error: "private detail" }),
    ).toMatchObject({ category: "configuration_error", code: "persona_not_configured" });
  });

  it("does not let response text override structured API metadata", () => {
    const error = verificationErrorFromApi(400, {
      code: "invalid_credential",
      category: "invalid_input",
      error: "Error(Contract, #4) Error(Auth, BadAuth) salt=private",
    });

    expect(error).toMatchObject({
      category: "invalid_input",
      code: "invalid_credential",
      httpStatus: 400,
      retryable: false,
    });
    expect(error.message).not.toContain("Error(Contract");
    expect(error.message).not.toContain("private");
  });

  it("uses HTTP status rather than message patterns for unstructured API failures", () => {
    expect(
      verificationErrorFromApi(503, { error: "Error(Auth, BadAuth) private transport detail" }),
    ).toMatchObject({ category: "network_error", code: 503, retryable: true });
  });

  it("preserves retryability for structured numeric contract codes", () => {
    expect(verificationErrorFromApi(502, { code: 11 })).toMatchObject({
      category: "policy_rejection",
      code: 11,
      retryable: true,
      httpStatus: 502,
    });
    expect(verificationErrorFromApi(502, { code: 11, retryable: false }).retryable).toBe(true);
  });

  it("honors explicit retryability for structured transport errors", () => {
    expect(
      verificationErrorFromApi(503, { code: "rpc_unavailable", retryable: false }),
    ).toMatchObject({ category: "network_error", code: "rpc_unavailable", retryable: false });
  });

  it("prefers typed configuration metadata over contract-like exception text", () => {
    expect(
      classifyVerificationError(new ConfigError("Error(Contract, #4) private detail")),
    ).toMatchObject({ category: "configuration_error", code: "configuration_error" });
  });

  it("uses a fixed message for arbitrary thrown objects while retaining the diagnostic code", () => {
    const raw = { code: "provider_code_17", message: "credential=private salt=secret" };
    const error = classifyVerificationError(raw);

    expect(error.code).toBe("provider_code_17");
    expect(error.category).toBe("unknown");
    expect(error.message).toBe(
      "The operation could not be completed. Try again or contact support with the diagnostic code.",
    );
    expect(error.message).not.toContain("private");
    expect(error.cause).toBe(raw);
  });

  it("does not treat inherited object properties as categories or message codes", () => {
    expect(classifyVerificationError({ category: "toString", code: "constructor" })).toMatchObject({
      category: "unknown",
      code: "constructor",
    });
    expect(classifyVerificationError({ category: "unknown", code: "toString" }).message).toBe(
      "The operation could not be completed. Try again or contact support with the diagnostic code.",
    );
  });

  it("prefers an explicit diagnostic code over the fallback code", () => {
    expect(
      classifyVerificationError(
        { code: "provider_code_17", message: "private transport detail" },
        { fallbackCategory: "unknown", fallbackCode: "proof_generation_failed" },
      ).code,
    ).toBe("provider_code_17");
  });

  it("returns an existing safe error unchanged", () => {
    const error = new VerificationError({ category: "expired_proof", code: 12 });
    expect(classifyVerificationError(error)).toBe(error);
  });

  it("keeps raw submission failures only in cause", () => {
    const raw = new Error("ECONNRESET credential=private salt=secret");
    const error = TransactionSubmissionError.fromRaw(raw);

    expect(error.code).toBe("network_error");
    expect(error.message).not.toContain("ECONNRESET");
    expect(error.message).not.toContain("private");
    expect(error.cause).toBe(raw);
  });
});
