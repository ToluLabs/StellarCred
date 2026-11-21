// @stellarcred/sdk — typed error taxonomy
//
// Structured errors that surface contract panics, RPC failures, and indexer
// issues as typed, actionable errors (#404). Every error code maps to the
// same human message everywhere (SDK, frontend, docs), with the contract's
// ProofRegistry error enum as the single source of truth.

/**
 * Maps ProofRegistry on-chain error codes to human-readable messages.
 * Kept in sync with the Rust contract's `Error` enum and the frontend's
 * `PROOF_REGISTRY_ERRORS` table (frontend/lib/contract-errors.ts).
 *
 * Contract error codes:
 *   NotInitialized          = 1
 *   VerificationFailed      = 2
 *   NotAuthorized           = 3
 *   IssuerNotTrusted        = 4
 *   IssuerKeyMismatch       = 5
 *   ProofNotFound           = 6
 *   BatchTooLarge           = 7
 *   BatchEmpty              = 8
 *   DuplicateCredentialType = 9
 *   AggregateLayoutInvalid  = 10
 *   SubmissionsPaused       = 11
 *   InvalidExpiry           = 12
 */
export const PROOF_REGISTRY_ERROR_MESSAGES: Record<number, string> = {
  1: "Contracts not initialised — check that all contract IDs are set in the environment.",
  2: "Proof verification failed — the ZK proof is invalid or was generated against the wrong circuit VK.",
  3: "Not authorised — wallet signature missing or wrong account.",
  4: "Issuer not trusted — the issuer address isn't registered for this credential type.",
  5: "Issuer key mismatch — this credential was signed with a key that doesn't match what's registered on-chain. Re-issue the credential and try again.",
  6: "Proof not found — no on-chain proof exists for this holder and credential type.",
  7: "Batch too large — reduce the number of proofs and try again.",
  8: "Batch is empty — include at least one proof submission.",
  9: "Duplicate credential type — the batch contains two proofs for the same claim type. Remove the duplicate and try again.",
  10: "Aggregate proof layout invalid — the number of credentials or public inputs don't match the expected format. Re-generate the aggregate proof.",
  11: "Submissions paused — the protocol admin has temporarily halted new proof submissions. Try again later.",
  12: "Invalid expiry — the credential expiry is either in the past or too far in the future. Re-issue with a valid validity window.",
};

/**
 * Contract error codes from the ProofRegistry contract's `Error` enum.
 * Exported as a const object so callers can switch on codes without hardcoding
 * magic numbers.
 */
export const ContractErrorCode = {
  NotInitialized: 1,
  VerificationFailed: 2,
  NotAuthorized: 3,
  IssuerNotTrusted: 4,
  IssuerKeyMismatch: 5,
  ProofNotFound: 6,
  BatchTooLarge: 7,
  BatchEmpty: 8,
  DuplicateCredentialType: 9,
  AggregateLayoutInvalid: 10,
  SubmissionsPaused: 11,
  InvalidExpiry: 12,
} as const;

export type ContractErrorCodeType = (typeof ContractErrorCode)[keyof typeof ContractErrorCode];

/**
 * Typed error surfaced when a ProofRegistry transaction fails with a contract
 * panic. Carries the numeric error code and a human message so callers can
 * branch programmatically (e.g. retry for transient errors, show terminal UI
 * for permanent failures) without parsing strings.
 *
 * @example
 * ```ts
 * try {
 *   await submitProof(...);
 * } catch (err) {
 *   if (err instanceof ContractError) {
 *     if (err.code === ContractErrorCode.IssuerNotTrusted) {
 *       // Show "issuer not registered" UI
 *     } else if (err.code === ContractErrorCode.VerificationFailed) {
 *       // Show "proof invalid" UI
 *     }
 *   }
 * }
 * ```
 */
export class ContractError extends Error {
  /**
   * Numeric error code from the contract's `Error` enum. Compare against
   * {@link ContractErrorCode} constants rather than hardcoding numbers.
   */
  code: number;

  /**
   * Human-readable error message from {@link PROOF_REGISTRY_ERROR_MESSAGES}.
   * Safe to display directly to users.
   */
  friendlyMessage: string;

  /**
   * Raw error string from the RPC/contract layer, e.g. `"Error(Contract, #4)"`.
   * Useful for debugging but not user-facing.
   */
  raw: string;

  constructor(code: number, friendlyMessage: string, raw: string) {
    super(friendlyMessage);
    this.name = "ContractError";
    this.code = code;
    this.friendlyMessage = friendlyMessage;
    this.raw = raw;
  }

  /**
   * Returns true if this error represents a transient/retryable failure
   * (e.g. submissions paused, RPC timeout) vs. a terminal failure that
   * requires user action (e.g. invalid proof, issuer not trusted).
   */
  isRetryable(): boolean {
    return this.code === ContractErrorCode.SubmissionsPaused;
  }

  /**
   * Returns true if this error indicates the holder needs to take action
   * before retrying (e.g. re-issue credential, register issuer).
   */
  isTerminal(): boolean {
    const terminalCodes: readonly number[] = [
      ContractErrorCode.VerificationFailed,
      ContractErrorCode.IssuerNotTrusted,
      ContractErrorCode.IssuerKeyMismatch,
      ContractErrorCode.InvalidExpiry,
      ContractErrorCode.NotInitialized,
    ];
    return terminalCodes.includes(this.code);
  }

  /**
   * Normalize an arbitrary thrown value into a structured {@link ContractError}
   * when it looks like a ProofRegistry contract panic, and otherwise return
   * null so callers can fall back to RpcError / generic handling.
   *
   * This is the preferred entry point for submission paths that receive raw
   * thrown values from the RPC/contract layer and want a consistent error
   * object with a `code` and human-readable `friendlyMessage`.
   */
  static fromRaw(raw: unknown): ContractError | null {
    if (raw instanceof ContractError) return raw;
    if (typeof raw === "string") return parseContractError(raw);
    if (raw && typeof raw === "object") {
      const candidate = raw as Record<string, unknown>;
      if (typeof candidate.message === "string") {
        return parseContractError(candidate.message);
      }
    }
    return null;
  }
}

/**
 * Parse a raw contract error string into a {@link ContractError}.
 * Handles multiple error formats from the RPC layer:
 * - `Error(Contract, #N)` → contract error code N
 * - `ContractError(N)` or `ContractError(Some(N))` → contract error code N
 * - Unrecognized → returns null (caller should handle as generic error)
 *
 * @example
 * ```ts
 * const err = parseContractError("Error(Contract, #4)");
 * if (err) {
 *   console.log(err.code); // 4
 *   console.log(err.friendlyMessage); // "Issuer not trusted..."
 * }
 * ```
 */
export function parseContractError(raw: string): ContractError | null {
  if (!raw) return null;

  // Match `Error(Contract, #N)` format
  let match = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (match) {
    const code = parseInt(match[1], 10);
    const message = PROOF_REGISTRY_ERROR_MESSAGES[code] ?? `Contract error #${code}.`;
    return new ContractError(code, message, raw);
  }

  // Match `ContractError(N)` or `ContractError(Some(N))` format (simulation errors)
  match = raw.match(/ContractError\((?:Some\()?(\d+)/);
  if (match) {
    const code = parseInt(match[1], 10);
    const message = PROOF_REGISTRY_ERROR_MESSAGES[code] ?? `Contract error #${code}.`;
    return new ContractError(code, message, raw);
  }

  return null;
}

/**
 * Error thrown when an RPC request to the Soroban network fails.
 * Distinguishes between network failures (timeout, unreachable), server errors
 * (500), and transaction failures (contract panic).
 */
export class RpcError extends Error {
  cause?: unknown;
  /** HTTP status code when the RPC responded with an error status. */
  status?: number;
  /** Parsed contract error if the RPC failure was due to a contract panic. */
  contractError?: ContractError;

  constructor(
    message = "Soroban RPC request failed",
    options?: { cause?: unknown; status?: number; contractError?: ContractError },
  ) {
    super(message);
    this.name = "RpcError";
    this.cause = options?.cause;
    this.status = options?.status;
    this.contractError = options?.contractError;
  }

  /**
   * Returns true if this RPC error wraps a contract panic (as opposed to
   * a network/timeout issue).
   */
  isContractError(): boolean {
    return this.contractError !== undefined;
  }
}

/**
 * Error thrown when an indexer request fails or returns malformed data.
 * Already exists in indexer.ts; re-exported here for completeness.
 */
export { IndexerError } from "./indexer";

// ---------------------------------------------------------------------------
// TransactionSubmissionError — dedicated error for submit_proof path (#744)
// ---------------------------------------------------------------------------

/**
 * Stable machine-readable codes for transaction submission failures.
 *
 * Callers can branch on `code` without parsing string messages:
 * - `"rate_limited"` — HTTP 429; safe to retry after a backoff.
 * - `"server_error"` — HTTP 5xx from the RPC host; safe to retry.
 * - `"network_error"` — socket/timeout failure; safe to retry.
 * - `"contract_error"` — on-chain contract panic; check `contractCode`
 *    against {@link ContractErrorCode} to decide if retryable.
 * - `"validation_error"` — bad input (invalid address, unknown claim type);
 *    never retryable.
 * - `"unknown"` — any other error not matching the categories above.
 */
export type TransactionSubmissionErrorCode =
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "contract_error"
  | "validation_error"
  | "unknown";

/**
 * Thrown by {@link submitTransaction} when a `submit_proof` transaction fails.
 *
 * Unlike raw `RpcError` / `ContractError`, this error always carries:
 * - `code` — a stable {@link TransactionSubmissionErrorCode} string for
 *   programmatic branching.
 * - `message` — a human-readable summary safe to display to users.
 * - optional `contractCode` — the numeric ProofRegistry error code when the
 *   failure was a contract panic, to allow fine-grained UI decisions.
 * - optional `httpStatus` — the HTTP status code from the RPC response.
 * - optional `retryable` — whether the caller can safely retry.
 *
 * @example
 * ```ts
 * import { submitTransaction, TransactionSubmissionError, ContractErrorCode } from "@stellarcred/sdk";
 *
 * try {
 *   await submitTransaction(myOperation);
 * } catch (err) {
 *   if (err instanceof TransactionSubmissionError) {
 *     if (err.retryable) {
 *       // Back off and try again
 *     } else if (err.code === "contract_error" && err.contractCode === ContractErrorCode.IssuerNotTrusted) {
 *       // Show "issuer not registered" UI
 *     } else {
 *       // Surface err.message to the user
 *     }
 *   }
 * }
 * ```
 */
export class TransactionSubmissionError extends Error {
  /**
   * Stable machine-readable code. Use this to branch without parsing strings.
   */
  readonly code: TransactionSubmissionErrorCode;

  /**
   * Human-readable summary of what failed. Safe to display to users.
   */
  override readonly message: string;

  /**
   * Whether the submission can be safely retried (e.g. 429, 5xx, network
   * error) vs. requires user action (validation error, terminal contract panic).
   */
  readonly retryable: boolean;

  /**
   * Numeric contract error code from {@link ContractErrorCode} when
   * `code === "contract_error"`. Undefined otherwise.
   */
  readonly contractCode?: number;

  /**
   * HTTP status code from the RPC response when available.
   */
  readonly httpStatus?: number;

  /**
   * Original thrown value before normalization. Useful for debugging.
   */
  readonly cause?: unknown;

  constructor(opts: {
    code: TransactionSubmissionErrorCode;
    message: string;
    retryable: boolean;
    contractCode?: number;
    httpStatus?: number;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "TransactionSubmissionError";
    this.code = opts.code;
    this.message = opts.message;
    this.retryable = opts.retryable;
    this.contractCode = opts.contractCode;
    this.httpStatus = opts.httpStatus;
    this.cause = opts.cause;
  }

  /**
   * Normalize an arbitrary thrown value from a submission path into a
   * {@link TransactionSubmissionError} with a stable `code`, `message`, and
   * `retryable` flag.
   *
   * Handles `RpcError`, `ContractError`, `ConfigError`, `InvalidAddressError`,
   * `InvalidClaimTypeError` and plain `Error` / unknown values.
   */
  static fromRaw(raw: unknown): TransactionSubmissionError {
    if (raw instanceof TransactionSubmissionError) return raw;

    // Already-typed RpcError — map HTTP status to a code.
    if (raw instanceof RpcError) {
      const status = raw.status;
      if (raw.contractError) {
        const ce = raw.contractError;
        return new TransactionSubmissionError({
          code: "contract_error",
          message: ce.friendlyMessage,
          retryable: ce.isRetryable(),
          contractCode: ce.code,
          httpStatus: status,
          cause: raw,
        });
      }
      if (status === 429) {
        return new TransactionSubmissionError({
          code: "rate_limited",
          message: "Request rate-limited by the RPC host. Please wait and try again.",
          retryable: true,
          httpStatus: status,
          cause: raw,
        });
      }
      if (status !== undefined && status >= 500 && status < 600) {
        return new TransactionSubmissionError({
          code: "server_error",
          message: `RPC server error (HTTP ${status}). The network may be degraded — please try again.`,
          retryable: true,
          httpStatus: status,
          cause: raw,
        });
      }
      return new TransactionSubmissionError({
        code: "network_error",
        message: raw.message || "Network error during transaction submission.",
        retryable: true,
        httpStatus: status,
        cause: raw,
      });
    }

    // Already-typed ContractError.
    if (raw instanceof ContractError) {
      return new TransactionSubmissionError({
        code: "contract_error",
        message: raw.friendlyMessage,
        retryable: raw.isRetryable(),
        contractCode: raw.code,
        cause: raw,
      });
    }

    // Validation errors from the SDK itself — never retryable.
    if (raw instanceof Error) {
      const validationNames = [
        "ConfigError",
        "InvalidAddressError",
        "InvalidClaimTypeError",
        "InvalidIssuerError",
        "InvalidThresholdError",
      ];
      if (validationNames.includes(raw.name)) {
        return new TransactionSubmissionError({
          code: "validation_error",
          message: raw.message,
          retryable: false,
          cause: raw,
        });
      }

      // Try to parse a raw contract-panic string out of the message.
      const parsed = parseContractError(raw.message);
      if (parsed) {
        return new TransactionSubmissionError({
          code: "contract_error",
          message: parsed.friendlyMessage,
          retryable: parsed.isRetryable(),
          contractCode: parsed.code,
          cause: raw,
        });
      }

      return new TransactionSubmissionError({
        code: "network_error",
        message: raw.message || "An unexpected error occurred during transaction submission.",
        retryable: true,
        cause: raw,
      });
    }

    // Unknown/non-Error thrown values.
    return new TransactionSubmissionError({
      code: "unknown",
      message: String(raw),
      retryable: false,
      cause: raw,
    });
  }
}
