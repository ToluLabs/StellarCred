// Unit tests for submitTransaction and TransactionSubmissionError (#744)
//
// Covers:
// - submitTransaction retries HTTP 429, 5xx, and network timeouts
// - submitTransaction does NOT retry terminal errors (4xx, invalid address, contract panics)
// - submitTransaction exhausts retries and throws TransactionSubmissionError
// - TransactionSubmissionError.fromRaw normalises every error shape correctly
// - onRetry callback fires with correct attempt count
// - classifyTransientFailure correctly classifies error kinds

import { describe, it, expect, vi } from "vitest";
import { submitTransaction } from "./submit";
import {
  TransactionSubmissionError,
  ContractError,
  ContractErrorCode,
  PROOF_REGISTRY_ERROR_MESSAGES,
  RpcError,
} from "./errors";
import {
  classifyTransientFailure,
  normalizeRpcError,
  ConfigError,
  InvalidAddressError,
} from "./claims";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRpcError(message: string, status: number): RpcError {
  return new RpcError(message, { status });
}

function makeContractError(code: number): ContractError {
  return new ContractError(
    code,
    PROOF_REGISTRY_ERROR_MESSAGES[code] ?? `Contract error #${code}.`,
    `Error(Contract, #${code})`,
  );
}

/** Fast retry options — zero delays so tests don't wait. */
const FAST_RETRY = { retries: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: false };

// ---------------------------------------------------------------------------
// submitTransaction — retry behaviour
// ---------------------------------------------------------------------------

describe("submitTransaction retries transient failures", () => {
  it("retries on HTTP 429 and succeeds on the third attempt", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls < 3) throw makeRpcError("Too many requests", 429);
      return "submitted";
    };

    const result = await submitTransaction(op, { retryOptions: FAST_RETRY });
    expect(result).toBe("submitted");
    expect(calls).toBe(3);
  });

  it("retries on HTTP 500 and succeeds on the second attempt", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls < 2) throw makeRpcError("Internal server error", 500);
      return "ok";
    };

    const result = await submitTransaction(op, { retryOptions: FAST_RETRY });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries on HTTP 503 and succeeds on the second attempt", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls < 2) throw makeRpcError("Service unavailable", 503);
      return "ok";
    };

    const result = await submitTransaction(op, { retryOptions: FAST_RETRY });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries on network timeout (generic Error) and succeeds", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls < 3) throw new Error("socket timeout");
      return "done";
    };

    const result = await submitTransaction(op, { retryOptions: FAST_RETRY });
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });

  it("retries on SubmissionsPaused contract error (retryable) and succeeds", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      if (calls < 3) throw makeContractError(ContractErrorCode.SubmissionsPaused);
      return "proof_submitted";
    };

    const result = await submitTransaction(op, { retryOptions: FAST_RETRY });
    expect(result).toBe("proof_submitted");
    expect(calls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// submitTransaction — non-retryable errors stop immediately
// ---------------------------------------------------------------------------

describe("submitTransaction does not retry terminal errors", () => {
  it("does NOT retry on HTTP 400 (bad request)", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw makeRpcError("Bad request", 400);
    };

    await expect(
      submitTransaction(op, { retryOptions: FAST_RETRY }),
    ).rejects.toBeInstanceOf(TransactionSubmissionError);

    expect(calls).toBe(1);
  });

  it("does NOT retry on a terminal ContractError (VerificationFailed)", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw makeContractError(ContractErrorCode.VerificationFailed);
    };

    await expect(
      submitTransaction(op, { retryOptions: FAST_RETRY }),
    ).rejects.toBeInstanceOf(TransactionSubmissionError);

    expect(calls).toBe(1);
  });

  it("does NOT retry on a terminal ContractError (IssuerNotTrusted)", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw makeContractError(ContractErrorCode.IssuerNotTrusted);
    };

    await expect(
      submitTransaction(op, { retryOptions: FAST_RETRY }),
    ).rejects.toBeInstanceOf(TransactionSubmissionError);

    expect(calls).toBe(1);
  });

  it("does NOT retry on a terminal ContractError (IssuerKeyMismatch)", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw makeContractError(ContractErrorCode.IssuerKeyMismatch);
    };

    await expect(
      submitTransaction(op, { retryOptions: FAST_RETRY }),
    ).rejects.toBeInstanceOf(TransactionSubmissionError);

    expect(calls).toBe(1);
  });

  it("does NOT retry on an InvalidAddressError (validation error)", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw new InvalidAddressError("Invalid Stellar address");
    };

    await expect(
      submitTransaction(op, { retryOptions: FAST_RETRY }),
    ).rejects.toBeInstanceOf(TransactionSubmissionError);

    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// submitTransaction — exhausts retries
// ---------------------------------------------------------------------------

describe("submitTransaction exhausts retries and throws TransactionSubmissionError", () => {
  it("throws after max retries with code='rate_limited' for HTTP 429", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw makeRpcError("Too many requests", 429);
    };

    const err = await submitTransaction(op, { retryOptions: FAST_RETRY }).catch((e) => e);

    expect(err).toBeInstanceOf(TransactionSubmissionError);
    expect((err as TransactionSubmissionError).code).toBe("rate_limited");
    expect((err as TransactionSubmissionError).retryable).toBe(true);
    expect((err as TransactionSubmissionError).httpStatus).toBe(429);
    // retries:3 means 1 initial + 3 retries = 4 total
    expect(calls).toBe(4);
  });

  it("throws after max retries with code='server_error' for HTTP 502", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      throw makeRpcError("Bad gateway", 502);
    };

    const err = await submitTransaction(op, { retryOptions: FAST_RETRY }).catch((e) => e);

    expect(err).toBeInstanceOf(TransactionSubmissionError);
    expect((err as TransactionSubmissionError).code).toBe("server_error");
    expect((err as TransactionSubmissionError).retryable).toBe(true);
    expect((err as TransactionSubmissionError).httpStatus).toBe(502);
  });

  it("throws with code='network_error' for a plain network Error after all retries", async () => {
    const op = async () => { throw new Error("ECONNRESET"); };

    const err = await submitTransaction(op, { retryOptions: FAST_RETRY }).catch((e) => e);

    expect(err).toBeInstanceOf(TransactionSubmissionError);
    expect((err as TransactionSubmissionError).code).toBe("network_error");
    expect((err as TransactionSubmissionError).retryable).toBe(true);
    expect((err as TransactionSubmissionError).message).toContain("ECONNRESET");
  });

  it("surfaces retryable=false and code='contract_error' for terminal contract panics", async () => {
    const op = async () => {
      throw makeContractError(ContractErrorCode.VerificationFailed);
    };

    const err = await submitTransaction(op, { retryOptions: FAST_RETRY }).catch((e) => e);

    expect(err).toBeInstanceOf(TransactionSubmissionError);
    expect((err as TransactionSubmissionError).code).toBe("contract_error");
    expect((err as TransactionSubmissionError).retryable).toBe(false);
    expect((err as TransactionSubmissionError).contractCode).toBe(ContractErrorCode.VerificationFailed);
    expect((err as TransactionSubmissionError).message).toContain("ZK proof is invalid");
  });

  it("surfaces retryable=true and code='contract_error' for SubmissionsPaused after all retries", async () => {
    const op = async () => { throw makeContractError(ContractErrorCode.SubmissionsPaused); };

    const err = await submitTransaction(op, {
      retryOptions: { retries: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(TransactionSubmissionError);
    expect((err as TransactionSubmissionError).code).toBe("contract_error");
    expect((err as TransactionSubmissionError).retryable).toBe(true);
    expect((err as TransactionSubmissionError).contractCode).toBe(ContractErrorCode.SubmissionsPaused);
  });
});

// ---------------------------------------------------------------------------
// onRetry callback
// ---------------------------------------------------------------------------

describe("submitTransaction onRetry callback", () => {
  it("calls onRetry once for each transient retry before success", async () => {
    let calls = 0;
    const onRetry = vi.fn();

    const op = async () => {
      calls++;
      if (calls < 3) throw makeRpcError("rate limited", 429);
      return "ok";
    };

    await submitTransaction(op, {
      retryOptions: FAST_RETRY,
      onRetry,
    });

    // 2 failures before success → onRetry called twice
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("passes a TransactionSubmissionError to onRetry with the correct code", async () => {
    let calls = 0;
    const retryErrors: TransactionSubmissionError[] = [];

    const op = async () => {
      calls++;
      if (calls < 2) throw makeRpcError("too many requests", 429);
      return "ok";
    };

    await submitTransaction(op, {
      retryOptions: FAST_RETRY,
      onRetry: (attempt, err) => retryErrors.push(err),
    });

    expect(retryErrors).toHaveLength(1);
    expect(retryErrors[0]).toBeInstanceOf(TransactionSubmissionError);
    expect(retryErrors[0].code).toBe("rate_limited");
  });

  it("does not call onRetry for non-transient (terminal) errors", async () => {
    const onRetry = vi.fn();

    const op = async () => {
      throw makeContractError(ContractErrorCode.IssuerNotTrusted);
    };

    await submitTransaction(op, {
      retryOptions: FAST_RETRY,
      onRetry,
    }).catch(() => {});

    expect(onRetry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TransactionSubmissionError.fromRaw — error normalization
// ---------------------------------------------------------------------------

describe("TransactionSubmissionError.fromRaw normalizes error shapes", () => {
  it("returns the same instance for an already-normalized TransactionSubmissionError", () => {
    const original = new TransactionSubmissionError({
      code: "rate_limited",
      message: "throttled",
      retryable: true,
      httpStatus: 429,
    });
    expect(TransactionSubmissionError.fromRaw(original)).toBe(original);
  });

  it("maps RpcError with status 429 → rate_limited, retryable=true", () => {
    const raw = makeRpcError("rate limited", 429);
    const err = TransactionSubmissionError.fromRaw(raw);

    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(429);
    expect(err.message).toMatch(/rate-limited/i);
  });

  it("maps RpcError with status 500 → server_error, retryable=true", () => {
    const raw = makeRpcError("internal error", 500);
    const err = TransactionSubmissionError.fromRaw(raw);

    expect(err.code).toBe("server_error");
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(500);
    expect(err.message).toContain("500");
  });

  it("maps RpcError wrapping a ContractError → contract_error with contractCode", () => {
    const contractError = makeContractError(ContractErrorCode.IssuerNotTrusted);
    const raw = new RpcError("tx failed", { contractError, status: 400 });
    const err = TransactionSubmissionError.fromRaw(raw);

    expect(err.code).toBe("contract_error");
    expect(err.retryable).toBe(false);
    expect(err.contractCode).toBe(ContractErrorCode.IssuerNotTrusted);
    expect(err.message).toContain("Issuer not trusted");
  });

  it("maps a ContractError directly → contract_error, non-retryable for terminal codes", () => {
    const raw = makeContractError(ContractErrorCode.VerificationFailed);
    const err = TransactionSubmissionError.fromRaw(raw);

    expect(err.code).toBe("contract_error");
    expect(err.retryable).toBe(false);
    expect(err.contractCode).toBe(ContractErrorCode.VerificationFailed);
  });

  it("maps a ContractError for SubmissionsPaused → contract_error, retryable=true", () => {
    const raw = makeContractError(ContractErrorCode.SubmissionsPaused);
    const err = TransactionSubmissionError.fromRaw(raw);

    expect(err.code).toBe("contract_error");
    expect(err.retryable).toBe(true);
    expect(err.contractCode).toBe(ContractErrorCode.SubmissionsPaused);
  });

  it("maps a plain Error with contract panic string → contract_error", () => {
    const raw = new Error("Error(Contract, #4)");
    const err = TransactionSubmissionError.fromRaw(raw);

    expect(err.code).toBe("contract_error");
    expect(err.contractCode).toBe(ContractErrorCode.IssuerNotTrusted);
    expect(err.message).toContain("Issuer not trusted");
  });

  it("maps an InvalidAddressError → validation_error, retryable=false", () => {
    const raw = new InvalidAddressError("Invalid Stellar address");
    const err = TransactionSubmissionError.fromRaw(raw);

    expect(err.code).toBe("validation_error");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("Invalid Stellar address");
  });

  it("maps a ConfigError → validation_error, retryable=false", () => {
    const raw = new ConfigError("SDK not configured: missing registryId");
    const err = TransactionSubmissionError.fromRaw(raw);

    expect(err.code).toBe("validation_error");
    expect(err.retryable).toBe(false);
  });

  it("maps a generic Error → network_error, retryable=true", () => {
    const raw = new Error("Connection refused");
    const err = TransactionSubmissionError.fromRaw(raw);

    expect(err.code).toBe("network_error");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("Connection refused");
    expect(err.cause).toBe(raw);
  });

  it("maps an unknown non-Error value → unknown, retryable=false", () => {
    const err = TransactionSubmissionError.fromRaw("some string error");

    expect(err.code).toBe("unknown");
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("some string error");
  });

  it("maps null/undefined → unknown, retryable=false", () => {
    const err = TransactionSubmissionError.fromRaw(undefined);
    expect(err.code).toBe("unknown");
    expect(err.retryable).toBe(false);
  });

  it("preserves cause for debugging", () => {
    const raw = makeRpcError("upstream", 500);
    const err = TransactionSubmissionError.fromRaw(raw);

    expect(err.cause).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// TransactionSubmissionError — basic class API
// ---------------------------------------------------------------------------

describe("TransactionSubmissionError class API", () => {
  it("has the correct name", () => {
    const err = new TransactionSubmissionError({
      code: "rate_limited",
      message: "throttled",
      retryable: true,
    });
    expect(err.name).toBe("TransactionSubmissionError");
    expect(err instanceof Error).toBe(true);
  });

  it("exposes all fields", () => {
    const cause = new Error("raw");
    const err = new TransactionSubmissionError({
      code: "contract_error",
      message: "issuer not trusted",
      retryable: false,
      contractCode: ContractErrorCode.IssuerNotTrusted,
      httpStatus: 400,
      cause,
    });

    expect(err.code).toBe("contract_error");
    expect(err.message).toBe("issuer not trusted");
    expect(err.retryable).toBe(false);
    expect(err.contractCode).toBe(ContractErrorCode.IssuerNotTrusted);
    expect(err.httpStatus).toBe(400);
    expect(err.cause).toBe(cause);
  });

  it("is instanceof Error and instanceof TransactionSubmissionError", () => {
    const err = TransactionSubmissionError.fromRaw(new Error("test"));
    expect(err instanceof Error).toBe(true);
    expect(err instanceof TransactionSubmissionError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyTransientFailure — transient error classification
// ---------------------------------------------------------------------------

describe("classifyTransientFailure correctly classifies error kinds", () => {
  it("classifies HTTP 429 as rate_limited", () => {
    const result = classifyTransientFailure(makeRpcError("too many requests", 429));
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("rate_limited");
    expect((result as { kind: "rate_limited"; statusCode: number }).statusCode).toBe(429);
  });

  it("classifies HTTP 500 as server_error", () => {
    const result = classifyTransientFailure(makeRpcError("internal error", 500));
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("server_error");
  });

  it("classifies HTTP 502 as server_error", () => {
    const result = classifyTransientFailure(makeRpcError("bad gateway", 502));
    expect(result?.kind).toBe("server_error");
  });

  it("classifies HTTP 503 as server_error", () => {
    const result = classifyTransientFailure(makeRpcError("service unavailable", 503));
    expect(result?.kind).toBe("server_error");
  });

  it("classifies a network timeout Error as network_error", () => {
    const result = classifyTransientFailure(new Error("socket timeout"));
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("network_error");
  });

  it("returns null for HTTP 400 (non-transient)", () => {
    const result = classifyTransientFailure(makeRpcError("bad request", 400));
    expect(result).toBeNull();
  });

  it("returns null for terminal ContractError (VerificationFailed)", () => {
    const result = classifyTransientFailure(makeContractError(ContractErrorCode.VerificationFailed));
    expect(result).toBeNull();
  });

  it("classifies SubmissionsPaused ContractError as server_error", () => {
    const result = classifyTransientFailure(makeContractError(ContractErrorCode.SubmissionsPaused));
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("server_error");
  });
});

// ---------------------------------------------------------------------------
// normalizeRpcError — error normalization coverage
// ---------------------------------------------------------------------------

describe("normalizeRpcError produces actionable RpcError with code and message", () => {
  it("wraps HTTP 429 with status and message", () => {
    const raw = makeRpcError("throttled", 429);
    const err = normalizeRpcError(raw, { message: "Submission throttled", status: 429 });

    expect(err).toBeInstanceOf(RpcError);
    expect(err.status).toBe(429);
    expect(err.message).toBe("Submission throttled");
    expect(err.cause).toBe(raw);
  });

  it("extracts contractError from contract panic string", () => {
    const raw = "Error(Contract, #4)";
    const err = normalizeRpcError(raw, { message: "tx failed", status: 400 });

    expect(err.contractError).toBeInstanceOf(ContractError);
    expect(err.contractError?.code).toBe(ContractErrorCode.IssuerNotTrusted);
    expect(err.contractError?.friendlyMessage).toContain("Issuer not trusted");
  });

  it("passes an existing ContractError through unchanged", () => {
    const contractError = makeContractError(ContractErrorCode.SubmissionsPaused);
    const err = normalizeRpcError(contractError, { message: "paused" });

    expect(err.contractError).toBe(contractError);
  });

  it("reads status from raw object when not provided explicitly", () => {
    const raw = { message: "upstream error", status: 502 };
    const err = normalizeRpcError(raw, { message: "upstream failure" });

    expect(err.status).toBe(502);
  });
});
