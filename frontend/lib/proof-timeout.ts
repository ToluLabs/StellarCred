// Proof deadline helpers — deliberately dependency-free.
//
// These live apart from lib/proof.ts because the UI needs them but must not
// pay for the proving engine: importing them from lib/proof would pull the
// whole wasm/CRS/aggregate module into the holder route chunk. They are pure
// AbortController plumbing, so they run unchanged on the main thread, inside
// the prover worker, or under jsdom.
//
// Stalled provers (wasm hang, network stall on witness fetch) should fail
// visibly instead of spinning forever. withTimeout composes a deadline onto
// the existing AbortController plumbing: the caller's signal is forwarded
// unchanged so user-initiated cancellation still works; when the deadline
// fires first we throw ProofTimeoutError instead of a raw AbortError.

// ── Proof timeout ─────────────────────────────────────────────────────────────
// Stalled provers (wasm hang, network stall on witness fetch) should fail
// visibly instead of spinning forever. withTimeout composes a deadline onto
// the existing AbortController plumbing: the caller's signal is forwarded
// unchanged so user-initiated cancellation still works; when the deadline
// fires first we throw ProofTimeoutError instead of a raw AbortError.

/** Default maximum time (ms) a proof generation step may take. */
export const DEFAULT_PROOF_TIMEOUT_MS = 120_000; // 2 minutes

/** Thrown when proof generation exceeds the timeout window. */
export class ProofTimeoutError extends Error {
  constructor(ms: number) {
    super(`Proof timed out after ${ms / 1000} seconds`);
    this.name = "ProofTimeoutError";
  }
}

/**
 * Wraps an abortable async function with a deadline. Returns the result or
 * throws `ProofTimeoutError` if the deadline fires before the function
 * resolves. The caller's `signal` is forwarded — when the *caller* aborts
 * (user cancel), the original error propagates unchanged; only a timeout
 * produces `ProofTimeoutError`.
 */
export function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const {
    timeoutMs = DEFAULT_PROOF_TIMEOUT_MS,
    signal: callerSignal,
  } = opts;

  // Short-circuit: caller already cancelled.
  if (callerSignal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Forward caller abort to our controller.
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort);

  const promise = fn(controller.signal).finally(() => {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  });

  // If timeout fired, swap the raw AbortError for a ProofTimeoutError.
  return promise.catch((err) => {
    if (timedOut) throw new ProofTimeoutError(timeoutMs);
    throw err;
  });
}
