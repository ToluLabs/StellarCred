// Retry backoff for the SDK's RPC, indexer and polling calls (#1056).
//
// Every network read and submission in the SDK goes through `withRetry`
// (claims.ts), which asks this module how long to wait before each retry.
// Fixed or purely exponential delays make clients that failed together retry
// together, so a congested or rate-limited RPC endpoint sees the same burst
// again on every retry. Jitter spreads those retries out.
//
// The default is full jitter: each delay is drawn uniformly from zero up to the
// exponential delay `min(maxDelayMs, baseDelayMs * 2^(attempt - 1))`. Clients
// that failed together spread across the whole window, and the worst-case
// retry time is the same as plain exponential backoff, so a fail-soft read
// does not hang longer during an outage than it did before #1056.
//
// Decorrelated jitter is available as `jitter: "decorrelated"`: each delay is
// drawn between the base delay and three times the previous delay, capped at
// `maxDelayMs`. It keeps a floor of `baseDelayMs` but grows faster: with the
// default 3 retries it can wait up to about 11 s instead of 3.5 s in total.
//
// Reference: "Exponential Backoff And Jitter", AWS Architecture Blog.
// This file has no imports so it stays trivially tree-shakeable and testable.

/**
 * How retry delays are randomised.
 *
 * - `"full"` (default): uniform in `[0, min(maxDelayMs, baseDelayMs * 2^(attempt - 1))]`.
 * - `"decorrelated"`: uniform in `[baseDelayMs, min(maxDelayMs, previousDelay * 3)]`.
 * - `"equal"`: half the exponential delay plus a random half (the SDK's
 *   behaviour before #1056).
 * - `"none"`: plain exponential delay, `min(maxDelayMs, baseDelayMs * 2^(attempt - 1))`.
 */
export type JitterStrategy = "decorrelated" | "full" | "equal" | "none";

/** Accepted values for the `jitter` option: a strategy, or `true` / `false`. */
export type JitterOption = boolean | JitterStrategy;

export const JITTER_STRATEGIES: readonly JitterStrategy[] = [
  "decorrelated",
  "full",
  "equal",
  "none",
];

/** The delay parameters a backoff strategy needs. */
export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: JitterStrategy;
}

/**
 * Map the public `jitter` option to a strategy. `true` (the default) selects
 * full jitter and `false` disables jitter entirely.
 */
export function resolveJitter(jitter: JitterOption | undefined): JitterStrategy {
  if (jitter === undefined || jitter === true) return "full";
  if (jitter === false) return "none";
  return jitter;
}

/** True when `value` is a valid `jitter` option. */
export function isJitterOption(value: unknown): value is JitterOption {
  return (
    typeof value === "boolean" ||
    (typeof value === "string" && (JITTER_STRATEGIES as readonly string[]).includes(value))
  );
}

/**
 * Delay in milliseconds before retry number `attempt` (1 for the first retry).
 *
 * `previousDelayMs` is the delay used before the previous retry (0 before the
 * first one); only the decorrelated strategy reads it. `random` returns a
 * number in `[0, 1)` and exists so tests can pin the jitter.
 *
 * The result is always within `[0, maxDelayMs]`.
 */
export function computeBackoffDelay(
  attempt: number,
  previousDelayMs: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const base = Math.max(0, policy.baseDelayMs);
  const cap = Math.max(0, policy.maxDelayMs);
  const exponential = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));

  switch (policy.jitter) {
    case "none":
      return exponential;
    case "equal":
      return exponential / 2 + random() * (exponential / 2);
    case "full":
      return random() * exponential;
    case "decorrelated": {
      const floor = Math.min(base, cap);
      const previous = previousDelayMs > 0 ? previousDelayMs : base;
      const ceiling = Math.min(cap, Math.max(floor, previous * 3));
      return floor + random() * (ceiling - floor);
    }
    default:
      return exponential;
  }
}

/**
 * The error to throw when `signal` aborts: its `reason` when the runtime sets
 * one (Node 17.2+ and modern browsers), otherwise an `AbortError`.
 */
export function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Wait `ms` milliseconds, rejecting with the abort reason as soon as `signal`
 * aborts. The timer and the abort listener are always cleaned up.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
