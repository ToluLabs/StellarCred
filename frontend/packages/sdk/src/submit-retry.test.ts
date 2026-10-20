import { describe, it, expect } from "vitest";
import {
  withRetry,
  normalizeRpcError,
} from "../src/claims";
import {
  RpcError,
  ContractError,
  ContractErrorCode,
  PROOF_REGISTRY_ERROR_MESSAGES,
} from "../src/errors";
// `NormalizedRpcErrorOptions` is intentionally imported from claims only when
// a test needs the shape; it is re-exported from claims, not from errors.

describe("withRetry handles transient failures with exponential backoff + jitter", () => {
  it("retries HTTP 429 and eventually succeeds", async () => {
    let calls = 0;
    const operation = async () => {
      calls++;
      if (calls < 3) {
        throw makeRpcError("Too many requests", 429);
      }
      return "ok";
    };

    const result = await withRetry(operation, {
      retries: 5,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("retries HTTP 500 and eventually succeeds", async () => {
    let calls = 0;
    const operation = async () => {
      calls++;
      if (calls < 2) {
        throw makeRpcError("Internal server error", 500);
      }
      return "ok";
    };

    const result = await withRetry(operation, {
      retries: 5,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries network timeout and eventually succeeds", async () => {
    let calls = 0;
    const operation = async () => {
      calls++;
      if (calls < 3) {
        throw new Error("socket timeout");
      }
      return "ok";
    };

    const result = await withRetry(operation, {
      retries: 5,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("stops retrying on HTTP 400 (non-transient)", async () => {
    let calls = 0;
    const operation = async () => {
      calls++;
      throw makeRpcError("Bad request", 400);
    };

    await expect(
      withRetry(operation, {
        retries: 5,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      }),
    ).rejects.toBeInstanceOf(RpcError);

    expect(calls).toBe(1);
  });

  it("stops retrying after max retries and surfaces the last error", async () => {
    let calls = 0;
    const operation = async () => {
      calls++;
      throw makeRpcError("service unavailable", 503);
    };

    await expect(
      withRetry(operation, {
        retries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      }),
    ).rejects.toBeInstanceOf(RpcError);

    expect(calls).toBe(3);
  });

  it("throws immediately on a terminal contract error without retrying", async () => {
    let calls = 0;
    const operation = async () => {
      calls++;
      throw new ContractError(
        ContractErrorCode.VerificationFailed,
        PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.VerificationFailed],
        "Error(Contract, #2)",
      );
    };

    await expect(
      withRetry(operation, {
        retries: 5,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      }),
    ).rejects.toBeInstanceOf(ContractError);

    expect(calls).toBe(1);
  });

  it("retries SubmissionsPaused contract error and eventually succeeds", async () => {
    let calls = 0;
    const operation = async () => {
      calls++;
      if (calls < 3) {
        throw new ContractError(
          ContractErrorCode.SubmissionsPaused,
          PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.SubmissionsPaused],
          "Error(Contract, #11)",
        );
      }
      return "submitted";
    };

    const result = await withRetry(operation, {
      retries: 5,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
    });
    expect(result).toBe("submitted");
    expect(calls).toBe(3);
  });
});

describe("normalizeRpcError surfaces actionable messages and code fields", () => {
  it("wraps a raw HTTP 429 into an RpcError with status and a thin cause", () => {
    const raw = new Error("rate limited");
    const err = normalizeRpcError(raw, {
      message: "Submission throttled",
      status: 429,
    });

    expect(err).toBeInstanceOf(RpcError);
    expect(err.name).toBe("RpcError");
    expect(err.message).toBe("Submission throttled");
    expect(err.status).toBe(429);
    expect(err.contractError).toBeUndefined();
    expect(err.cause).toBe(raw);
  });

  it("normalizes a contract panic string into RpcError.contractError with code and friendlyMessage", () => {
    const raw = "Error(Contract, #4)";
    const err = normalizeRpcError(raw, {
      message: "Transaction failed",
      status: 400,
    });

    expect(err).toBeInstanceOf(RpcError);
    expect(err.contractError).toBeInstanceOf(ContractError);
    expect(err.contractError?.code).toBe(ContractErrorCode.IssuerNotTrusted);
    expect(err.contractError?.friendlyMessage).toContain("Issuer not trusted");
    expect(err.contractError?.raw).toBe(raw);
  });

  it("carries an existing ContractError through without reparsing", () => {
    const contractError = new ContractError(
      ContractErrorCode.SubmissionsPaused,
      PROOF_REGISTRY_ERROR_MESSAGES[ContractErrorCode.SubmissionsPaused],
      "Error(Contract, #11)",
    );
    const err = normalizeRpcError(contractError, {
      message: "Submission paused",
    });

    expect(err.contractError).toBe(contractError);
    expect(err.contractError?.code).toBe(ContractErrorCode.SubmissionsPaused);
  });

  it("keeps status from the raw object when present", () => {
    const raw = { message: "upstream error", status: 502 };
    const err = normalizeRpcError(raw, {
      message: "upstream failure",
    });

    expect(err.status).toBe(502);
    expect(err.contractError).toBeUndefined();
  });

  it("returns null from parseContractError for unrecognized strings", () => {
    const err = normalizeRpcError("something vague", {
      message: "failed",
      status: 500,
    });

    expect(err.contractError).toBeUndefined();
    expect(err.status).toBe(500);
  });
});

/** Minimal RpcError factory used by tests that cannot import the link dep. */
function makeRpcError(message: string, status: number): RpcError {
  return new RpcError(message, { status });
}
