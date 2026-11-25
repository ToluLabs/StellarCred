// @stellarcred/sdk — typed error taxonomy
//
// Structured errors that surface contract panics, RPC failures, and indexer
// issues as typed, actionable errors (#404). Every error code maps to the
// same human message everywhere (SDK, frontend, docs), with the contract's
// ProofRegistry error enum as the single source of truth.

export type VerificationErrorCategory =
  | "policy_rejection"
  | "expired_proof"
  | "unsupported_credential"
  | "network_error"
  | "invalid_input"
  | "configuration_error"
  | "authorization_error"
  | "unknown";

export type VerificationErrorCode = string | number;

const CATEGORY_MESSAGES: Record<VerificationErrorCategory, string> = {
  policy_rejection:
    "The credential does not meet the verification policy. Review it or ask the issuer to re-issue it.",
  expired_proof:
    "The proof has expired. Ask the issuer for a new credential or generate a new proof.",
  unsupported_credential:
    "This credential or proof format is not supported. Re-issue or import a supported credential.",
  network_error:
    "The Stellar network is temporarily unavailable. Check your connection and try again.",
  invalid_input:
    "The request contains invalid or incomplete credential data. Review it and try again.",
  configuration_error: "StellarCred is not configured correctly. Contact the app operator.",
  authorization_error: "Wallet authorisation failed. Reconnect the correct wallet and try again.",
  unknown:
    "The operation could not be completed. Try again or contact support with the diagnostic code.",
};

const CODE_MESSAGES: Record<string, string> = {
  circuit_version_mismatch:
    "This credential was issued for a circuit version this app cannot prove. Ask the issuer to re-issue it.",
  input_too_large:
    "The credential payload is too large to process. Use a smaller payload and try again.",
  invalid_request: "The request is missing required fields or has an invalid format.",
  invalid_credential: "The credential data is invalid or incomplete. Review it and try again.",
  invalid_address: "The Stellar address is invalid. Review it and try again.",
  invalid_threshold: "The claim threshold is invalid. Enter a valid threshold and try again.",
  invalid_transaction:
    "The transaction could not be built from the supplied credential data. Review it and try again.",
  wallet_authorization: "Wallet authorisation failed. Reconnect the correct wallet and try again.",
  unsupported_credential:
    "This credential or proof format is not supported. Re-issue or import a supported credential.",
  proof_not_found: "No on-chain proof was found for this wallet and credential type.",
  proof_revoked: "This credential proof was revoked by its issuer.",
  issuer_not_trusted: "The credential issuer is not in the trusted issuers list.",
  threshold_not_met: "The proven threshold is lower than the verification policy requires.",
  claim_read_failed:
    "The claim could not be checked. Try again or contact support with the diagnostic code.",
  witness_generation_failed:
    "The credential could not be used to generate a witness. Review it and try again.",
  rpc_timeout: "The Stellar network did not respond in time. Try again.",
  aborted: "The operation was cancelled.",
  issuance_failed:
    "Credential issuance could not be completed. Try again or contact support with the diagnostic code.",
  persona_not_configured: "Identity verification is not configured. Contact the app operator.",
  persona_unavailable: "Identity verification is temporarily unavailable. Please try again.",
  persona_invalid_response: "Identity verification returned an invalid response. Please try again.",
  persona_declined: "Identity verification was declined.",
  persona_expired: "The identity verification inquiry expired. Start a new inquiry.",
  persona_incomplete: "Identity verification has not been completed.",
  PLAID_TIMEOUT: "Balance verification timed out. Please try again.",
  PLAID_UNAVAILABLE: "Balance verification is temporarily unavailable. Please try again.",
  PLAID_ERROR: "Balance verification failed. Try again or contact support.",
  capabilities_unavailable:
    "Deployment capabilities are temporarily unavailable. Check your connection and try again.",
  capabilities_invalid_response:
    "The deployment returned an invalid capability descriptor. Contact the app operator.",
  proof_registry_not_configured:
    "ProofRegistry contract id not set. Deploy the contracts and fill NEXT_PUBLIC_PROOF_REGISTRY_ID.",
  invalid_issuer: "The issuer address is invalid. Review it and try again.",
  issuer_key_mismatch:
    "The server signing key does not match the selected issuer's registered public key. Contact the app operator.",
  invalid_ttl_values: "Provide one valid expiry value for each credential and try again.",
  indexer_unavailable: "The credential indexer is temporarily unavailable. Please try again.",
  indexer_invalid_response:
    "The credential indexer returned an invalid response. Please try again or contact the app operator.",
  webhook_delivery_failed:
    "The credential event could not be delivered to the configured webhook. Please try again.",
  event_stream_failed: "The credential event stream could not be processed. Please try again.",
  event_stream_invalid_url: "The credential event stream URL is invalid.",
  event_stream_websocket_unavailable:
    "The credential event stream WebSocket transport is unavailable. Contact the app operator.",
  event_stream_sse_unavailable:
    "The credential event stream SSE transport is unavailable. Contact the app operator.",
  event_stream_connection_failed:
    "The credential event stream could not connect. Check your connection and try again.",
  event_stream_retries_exhausted:
    "The credential event stream could not reconnect. Check the connection and try connecting again.",
  rpc_unavailable: "The Stellar network is temporarily unavailable. Please try again.",
  witness_rpc_not_configured:
    "The witness service is not configured to read the Stellar ledger. Contact the app operator.",
  witness_rpc_unavailable:
    "The Stellar RPC is temporarily unavailable. Check your connection and try again.",
  witness_rpc_invalid_response:
    "The Stellar RPC returned an invalid ledger time. Try again or contact the app operator.",
  witness_rpc_timeout: "The Stellar RPC did not respond in time. Please try again.",
  transaction_rejected: "The transaction was rejected. Review the credential and try again.",
  transaction_not_confirmed:
    "The transaction was not confirmed. Check its status before submitting it again.",
};

export function safeVerificationMessage(
  category: VerificationErrorCategory,
  code?: VerificationErrorCode,
): string {
  if (typeof code === "number" && hasOwn(PROOF_REGISTRY_ERROR_MESSAGES, code)) {
    return PROOF_REGISTRY_ERROR_MESSAGES[code];
  }
  return (
    (typeof code === "string" && hasOwn(CODE_MESSAGES, code) ? CODE_MESSAGES[code] : undefined) ??
    CATEGORY_MESSAGES[category]
  );
}

export class VerificationError extends Error {
  readonly category: VerificationErrorCategory;
  readonly code: VerificationErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  override readonly message: string;
  readonly cause?: unknown;

  constructor(opts: {
    category: VerificationErrorCategory;
    code: VerificationErrorCode;
    retryable?: boolean;
    httpStatus?: number;
    cause?: unknown;
  }) {
    super(safeVerificationMessage(opts.category, opts.code));
    this.name = "VerificationError";
    this.category = opts.category;
    this.code = opts.code;
    this.retryable = opts.retryable ?? opts.category === "network_error";
    this.httpStatus = opts.httpStatus;
    this.cause = opts.cause;
    this.message = safeVerificationMessage(opts.category, opts.code);
  }
}

export function contractErrorCategory(code: number): VerificationErrorCategory {
  if (code === 1) return "configuration_error";
  if (code === 3 || code === 13 || code === 14) return "authorization_error";
  if (code === 12) return "invalid_input";
  if (code >= 7 && code <= 10) return "invalid_input";
  return "policy_rejection";
}

const API_ERROR_CATEGORIES: Record<string, VerificationErrorCategory> = {
  circuit_version_mismatch: "unsupported_credential",
  unsupported: "unsupported_credential",
  unsupported_credential: "unsupported_credential",
  expired: "expired_proof",
  expired_proof: "expired_proof",
  invalid_request: "invalid_input",
  invalid_credential: "invalid_input",
  input_too_large: "invalid_input",
  validation_error: "invalid_input",
  rate_limited: "network_error",
  server_error: "network_error",
  network_error: "network_error",
  indexer_unavailable: "network_error",
  indexer_invalid_response: "network_error",
  indexer_network_error: "network_error",
  timeout: "network_error",
  rpc_timeout: "network_error",
  rpc_unavailable: "network_error",
  witness_rpc_not_configured: "configuration_error",
  witness_rpc_unavailable: "network_error",
  witness_rpc_invalid_response: "network_error",
  witness_rpc_timeout: "network_error",
  persona_unavailable: "network_error",
  persona_invalid_response: "network_error",
  PLAID_TIMEOUT: "network_error",
  PLAID_UNAVAILABLE: "network_error",
  capabilities_unavailable: "network_error",
  contract_error: "policy_rejection",
  configuration_error: "configuration_error",
  not_configured: "configuration_error",
  persona_not_configured: "configuration_error",
  capabilities_invalid_response: "configuration_error",
  persona_declined: "policy_rejection",
  persona_expired: "invalid_input",
  persona_incomplete: "invalid_input",
  invalid_issuer: "invalid_input",
  issuer_key_mismatch: "configuration_error",
  authorization_error: "authorization_error",
};

const ERROR_NAME_CATEGORIES: Record<string, VerificationErrorCategory> = {
  CircuitVersionMismatchError: "unsupported_credential",
  InvalidClaimTypeError: "unsupported_credential",
  ConfigError: "configuration_error",
  InvalidAddressError: "invalid_input",
  InvalidIssuerError: "invalid_input",
  InvalidThresholdError: "invalid_input",
  ProofResourceError: "invalid_input",
  ProofTimeoutError: "network_error",
  TimeoutError: "network_error",
  ReadTimeoutError: "network_error",
};

const ERROR_NAME_CODES: Record<string, string> = {
  CircuitVersionMismatchError: "circuit_version_mismatch",
  InvalidClaimTypeError: "unsupported_credential",
  ConfigError: "configuration_error",
  InvalidAddressError: "invalid_address",
  InvalidIssuerError: "invalid_issuer",
  InvalidThresholdError: "invalid_threshold",
  ProofResourceError: "input_too_large",
  ProofTimeoutError: "timeout",
  TimeoutError: "timeout",
  ReadTimeoutError: "rpc_timeout",
};

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function diagnosticCode(value: unknown): VerificationErrorCode | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
}

function diagnosticCategory(value: unknown): VerificationErrorCategory | undefined {
  return typeof value === "string" && hasOwn(CATEGORY_MESSAGES, value)
    ? (value as VerificationErrorCategory)
    : undefined;
}

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
 *   RoleNotHeld             = 13
 *   RoleHolderMismatch      = 14
 *   NoPendingAdmin          = 15
 *   NullifierAlreadyUsed    = 16
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
  13: "Required role not held — this wallet is not authorised to perform the operation.",
  14: "Role holder mismatch — the authorised role belongs to a different wallet.",
  15: "No pending admin — there is no admin transfer proposal to accept or cancel.",
  16: "Nullifier already used — this proof has already been recorded for the application context.",
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
  RoleNotHeld: 13,
  RoleHolderMismatch: 14,
  NoPendingAdmin: 15,
  NullifierAlreadyUsed: 16,
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
function submissionErrorCategory(
  code: TransactionSubmissionErrorCode,
  contractCode?: number,
): VerificationErrorCategory {
  if (contractCode !== undefined) return contractErrorCategory(contractCode);
  if (code === "network_error" || code === "server_error" || code === "rate_limited") {
    return "network_error";
  }
  if (code === "validation_error") return "invalid_input";
  if (code === "contract_error") return "policy_rejection";
  return "unknown";
}

export class TransactionSubmissionError extends Error {
  /**
   * Stable machine-readable code. Use this to branch without parsing strings.
   */
  readonly code: TransactionSubmissionErrorCode;
  readonly category: VerificationErrorCategory;

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
    category?: VerificationErrorCategory;
    contractCode?: number;
    httpStatus?: number;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "TransactionSubmissionError";
    this.code = opts.code;
    this.category = opts.category ?? submissionErrorCategory(opts.code, opts.contractCode);
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
        const error = classifyVerificationError(raw);
        return new TransactionSubmissionError({
          code: "rate_limited",
          message: error.message,
          retryable: true,
          category: error.category,
          httpStatus: status,
          cause: raw,
        });
      }
      if (status !== undefined && status >= 500 && status < 600) {
        const error = classifyVerificationError(raw);
        return new TransactionSubmissionError({
          code: "server_error",
          message: error.message,
          retryable: true,
          category: error.category,
          httpStatus: status,
          cause: raw,
        });
      }
      if (status !== undefined && status >= 400 && status < 500) {
        const error = classifyVerificationError(raw);
        return new TransactionSubmissionError({
          code: status === 408 ? "network_error" : "validation_error",
          message: error.message,
          retryable: error.retryable,
          category: error.category,
          httpStatus: status,
          cause: raw,
        });
      }
      const error = classifyVerificationError(raw);
      return new TransactionSubmissionError({
        code: "network_error",
        message: error.message,
        retryable: true,
        category: error.category,
        httpStatus: status,
        cause: raw,
      });
    }

    if (raw instanceof ContractError) {
      return new TransactionSubmissionError({
        code: "contract_error",
        message: raw.friendlyMessage,
        retryable: raw.isRetryable(),
        contractCode: raw.code,
        cause: raw,
      });
    }

    const parsed = ContractError.fromRaw(raw);
    if (parsed) {
      return new TransactionSubmissionError({
        code: "contract_error",
        message: parsed.friendlyMessage,
        retryable: parsed.isRetryable(),
        contractCode: parsed.code,
        cause: raw,
      });
    }

    if (raw instanceof Error) {
      const error = classifyVerificationError(raw, {
        fallbackCategory: "network_error",
        fallbackCode: "network_error",
      });
      const terminal =
        !error.retryable && error.category !== "network_error" && error.category !== "unknown";
      const contractCode =
        typeof error.code === "number" && hasOwn(PROOF_REGISTRY_ERROR_MESSAGES, error.code)
          ? error.code
          : undefined;
      return new TransactionSubmissionError({
        code:
          contractCode !== undefined
            ? "contract_error"
            : terminal
              ? "validation_error"
              : "network_error",
        message: error.message,
        retryable: error.retryable,
        category: error.category,
        contractCode,
        httpStatus: error.httpStatus,
        cause: raw,
      });
    }

    const error = classifyVerificationError(raw);
    return new TransactionSubmissionError({
      code: "unknown",
      message: error.message,
      retryable: false,
      category: error.category,
      httpStatus: error.httpStatus,
      cause: raw,
    });
  }
}

export interface VerificationErrorContext {
  fallbackCategory?: VerificationErrorCategory;
  fallbackCode?: VerificationErrorCode;
  /** Disable for untrusted response bodies; structured metadata is still classified. */
  parseErrorMessages?: boolean;
}

export function classifyVerificationError(
  raw: unknown,
  context: VerificationErrorContext = {},
): VerificationError {
  if (raw instanceof VerificationError) return raw;

  const candidate = recordOf(raw);
  const name =
    raw instanceof Error
      ? raw.name
      : typeof candidate?.name === "string"
        ? candidate.name
        : undefined;
  const explicitCode = diagnosticCode(candidate?.code);
  const explicitRetryable =
    typeof candidate?.retryable === "boolean" ? candidate.retryable : undefined;
  const contractCode = diagnosticCode(candidate?.contractCode);
  const status =
    typeof candidate?.status === "number"
      ? candidate.status
      : typeof candidate?.httpStatus === "number"
        ? candidate.httpStatus
        : undefined;

  if (raw instanceof ContractError) {
    return new VerificationError({
      category: contractErrorCategory(raw.code),
      code: raw.code,
      retryable: raw.isRetryable(),
      cause: raw,
    });
  }

  if (raw instanceof RpcError && raw.contractError) {
    return classifyVerificationError(raw.contractError);
  }

  if (raw instanceof TransactionSubmissionError) {
    return new VerificationError({
      category: raw.category,
      code: raw.contractCode ?? raw.code,
      retryable: raw.retryable,
      httpStatus: raw.httpStatus,
      cause: raw,
    });
  }

  const numericContractCode =
    typeof contractCode === "number"
      ? contractCode
      : typeof explicitCode === "number" && hasOwn(PROOF_REGISTRY_ERROR_MESSAGES, explicitCode)
        ? explicitCode
        : undefined;
  if (numericContractCode !== undefined) {
    return new VerificationError({
      category: contractErrorCategory(numericContractCode),
      code: numericContractCode,
      retryable: numericContractCode === ContractErrorCode.SubmissionsPaused,
      httpStatus: status,
      cause: raw,
    });
  }

  const explicitCategory = diagnosticCategory(candidate?.category);
  const apiCategory =
    typeof explicitCode === "string" && hasOwn(API_ERROR_CATEGORIES, explicitCode)
      ? API_ERROR_CATEGORIES[explicitCode]
      : undefined;
  const nameCategory =
    name && hasOwn(ERROR_NAME_CATEGORIES, name) ? ERROR_NAME_CATEGORIES[name] : undefined;
  const category = explicitCategory ?? apiCategory ?? nameCategory;
  const code =
    explicitCode ??
    (name && hasOwn(ERROR_NAME_CODES, name) ? ERROR_NAME_CODES[name] : undefined) ??
    context.fallbackCode ??
    "unknown";

  if (category) {
    return new VerificationError({
      category,
      code,
      retryable: explicitRetryable ?? category === "network_error",
      httpStatus: status,
      cause: raw,
    });
  }

  if (context.parseErrorMessages !== false) {
    if (typeof raw === "string") {
      const parsed = parseContractError(raw);
      if (parsed) return classifyVerificationError(parsed);
    }

    const message =
      raw instanceof Error
        ? raw.message
        : typeof raw === "string"
          ? raw
          : typeof candidate?.message === "string"
            ? candidate.message
            : "";
    const parsed = parseContractError(message);
    if (parsed) {
      return new VerificationError({
        category: contractErrorCategory(parsed.code),
        code: explicitCode ?? parsed.code,
        retryable: parsed.isRetryable(),
        httpStatus: status,
        cause: raw,
      });
    }

    if (name === "AbortError") {
      return new VerificationError({
        category: "unknown",
        code: explicitCode ?? "aborted",
        retryable: false,
        cause: raw,
      });
    }

    if (message.includes("Error(Auth")) {
      return new VerificationError({
        category: "authorization_error",
        code: explicitCode ?? "wallet_authorization",
        retryable: false,
        cause: raw,
      });
    }

    if (message.includes("Error(WasmVm")) {
      return new VerificationError({
        category: "invalid_input",
        code: explicitCode ?? "malformed_proof",
        retryable: false,
        cause: raw,
      });
    }
  }

  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return new VerificationError({
      category: "network_error",
      code: explicitCode ?? status,
      retryable: explicitRetryable ?? true,
      httpStatus: status,
      cause: raw,
    });
  }
  if (status === 401 || status === 403) {
    return new VerificationError({
      category: "authorization_error",
      code: explicitCode ?? status,
      retryable: false,
      httpStatus: status,
      cause: raw,
    });
  }
  if (status !== undefined && status >= 400) {
    return new VerificationError({
      category: "invalid_input",
      code: explicitCode ?? status,
      retryable: false,
      httpStatus: status,
      cause: raw,
    });
  }

  if (raw instanceof RpcError || name === "IndexerError") {
    return new VerificationError({
      category: "network_error",
      code: explicitCode ?? "network_error",
      retryable: explicitRetryable ?? true,
      httpStatus: status,
      cause: raw,
    });
  }

  return new VerificationError({
    category: context.fallbackCategory ?? "unknown",
    code: explicitCode ?? context.fallbackCode ?? "unknown",
    retryable: context.fallbackCategory === "network_error",
    httpStatus: status,
    cause: raw,
  });
}

export function verificationErrorFromApi(status: number, body: unknown): VerificationError {
  const candidate = recordOf(body);
  return classifyVerificationError({ ...(candidate ?? {}), status }, { parseErrorMessages: false });
}
