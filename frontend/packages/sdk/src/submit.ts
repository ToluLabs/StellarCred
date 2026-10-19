// @stellarcred/sdk — submitTransaction wrapper (#744)
//
// Provides a single entry point for the submit_proof transaction path that
// wires together exponential-backoff retry (withRetry), transient-failure
// classification (classifyTransientFailure), and error normalization
// (TransactionSubmissionError.fromRaw) so callers receive a consistent,
// actionable error object on every failure.
//
// Usage:
//   import { submitTransaction } from "@stellarcred/sdk";
//
//   await submitTransaction(() => client.submit_proof(args));
//   // On failure: throws TransactionSubmissionError with code + message + retryable

import { withRetry, classifyTransientFailure, type RetryOptions } from "./claims";
import {
  TransactionSubmissionError,
  type TransactionSubmissionErrorCode,
} from "./errors";

export { TransactionSubmissionError };
export type { TransactionSubmissionErrorCode };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SubmitTransactionOptions {
  /**
   * Retry options forwarded to {@link withRetry}.
   *
   * Defaults to the SDK-wide config values (`retries: 3`,
   * `baseDelayMs: 500`, `maxDelayMs: 5000`, `jitter: true`).
   */
  retryOptions?: RetryOptions;

  /**
   * Optional hook called before each retry attempt. Useful for logging or
   * surfacing retry progress in UI.
   *
   * @param attempt - 1-based attempt number (attempt 1 is the first retry).
   * @param error   - The error that triggered this retry.
   * @param delayMs - Approximate delay in milliseconds before this retry.
   */
  onRetry?: (attempt: number, error: TransactionSubmissionError, delayMs: number) => void;
}

// ---------------------------------------------------------------------------
// submitTransaction
// ---------------------------------------------------------------------------

/**
 * Submit a Soroban transaction (typically `submit_proof`) with automatic
 * retry for transient failures and normalized error objects on every failure.
 *
 * ## What it does
 * 1. Wraps `operation` in {@link withRetry}, which retries on HTTP 429, 5xx,
 *    and network timeouts with exponential backoff and jitter.
 * 2. On each transient failure, calls `opts.onRetry` when provided.
 * 3. When all attempts are exhausted, or on a non-retryable error, converts
 *    the raw error to a {@link TransactionSubmissionError} so callers always
 *    receive a stable `{ code, message, retryable }` shape.
 *
 * ## Error codes
 * - `"rate_limited"`    — HTTP 429; back off and retry.
 * - `"server_error"`    — HTTP 5xx; back off and retry.
 * - `"network_error"`   — socket / timeout; back off and retry.
 * - `"contract_error"`  — on-chain contract panic; check `contractCode` and
 *                         `retryable` — most contract errors require user action.
 * - `"validation_error"`— bad input (invalid address, claim type …); fix input.
 * - `"unknown"`          — unexpected; inspect `cause`.
 *
 * @example
 * ```ts
 * import { submitTransaction, TransactionSubmissionError, ContractErrorCode } from "@stellarcred/sdk";
 *
 * try {
 *   const result = await submitTransaction(
 *     () => proofRegistryClient.submit_proof(args),
 *     {
 *       retryOptions: { retries: 4, baseDelayMs: 800 },
 *       onRetry: (attempt, err) =>
 *         console.warn(`Retry #${attempt}: ${err.message}`),
 *     },
 *   );
 *   console.log("Submitted:", result);
 * } catch (err) {
 *   if (err instanceof TransactionSubmissionError) {
 *     if (err.retryable) {
 *       console.error("All retries exhausted:", err.message);
 *     } else if (err.code === "contract_error" && err.contractCode === ContractErrorCode.IssuerNotTrusted) {
 *       console.error("Issuer not registered on-chain");
 *     } else {
 *       console.error("Fatal:", err.message);
 *     }
 *   }
 * }
 * ```
 */
export async function submitTransaction<T>(
  operation: () => Promise<T>,
  opts?: SubmitTransactionOptions,
): Promise<T> {
  // Track attempt count for onRetry callbacks.
  let attempt = 0;

  // Wrap the raw operation so we can intercept each failure, call onRetry if
  // configured, and re-throw.  withRetry sees the re-thrown raw error and
  // applies its own retry/backoff logic unchanged.
  const wrappedOperation = async (): Promise<T> => {
    try {
      return await operation();
    } catch (raw) {
      attempt++;

      if (opts?.onRetry) {
        // Classify to determine if this is a transient failure worth reporting.
        const transient = classifyTransientFailure(raw);
        if (transient) {
          const normalized = TransactionSubmissionError.fromRaw(raw);
          // Estimate the delay that withRetry will use for the *next* attempt.
          // We pass 0 here if we can't compute it — it is purely informational.
          opts.onRetry(attempt, normalized, 0);
        }
      }

      throw raw; // re-throw so withRetry can decide whether to retry.
    }
  };

  try {
    return await withRetry(wrappedOperation, opts?.retryOptions);
  } catch (raw) {
    // All retries exhausted or non-retryable error — normalize and throw.
    throw TransactionSubmissionError.fromRaw(raw);
  }
}
