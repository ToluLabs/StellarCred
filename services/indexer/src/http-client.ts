/**
 * http-client.ts — shared outbound HTTP wrapper with retry + circuit breaker (#761).
 *
 * External APIs we call (Horizon, and anything added later) answer with 429
 * when we exceed their rate limit and with transient 5xx when they are unhappy.
 * Calling code that handles that itself grows a bespoke retry loop per module
 * (ingester.ts has one, webhooks.ts has another). This is the version those
 * sites — and every future one — can share:
 *
 *   Retries:         exponential backoff with jitter for 429 / 408 / 5xx /
 *                    network errors, honouring `Retry-After`. Any other
 *                    response (including 404) is returned untouched — an
 *                    answer is not a failure and is not retried.
 *   Circuit breaker: after `failureThreshold` consecutive calls that exhaust
 *                    their retries, the breaker opens and further calls fail
 *                    fast with CircuitOpenError without touching the network,
 *                    until `resetTimeoutMs` later when a single probe is
 *                    allowed through (half-open). Success closes it; failure
 *                    re-opens it.
 *
 * Everything is configurable (see HttpClientConfig in ./config), and every
 * retry/backoff/breaker transition is written to the injected logger so a
 * rate-limited provider is visible in the logs rather than silently absorbed.
 */

import type { HttpClientConfig } from "./config";

export interface RetryPolicy {
  /** Total attempts per call, including the first. 1 disables retrying. */
  maxAttempts: number;
  /** Base backoff in ms; doubled per attempt (attempt 1 → base, 2 → 2×base …). */
  baseDelayMs: number;
  /** Cap on any single backoff wait, in ms. Also caps a huge Retry-After. */
  maxDelayMs: number;
  /** Fraction (0..1) of the computed delay added as random jitter. 0 disables. */
  jitterRatio: number;
}

export interface BreakerPolicy {
  /** Consecutive failed (retries-exhausted) calls before the breaker opens. */
  failureThreshold: number;
  /** How long the breaker stays open before allowing a half-open probe. */
  resetTimeoutMs: number;
}

export interface HttpClientLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpClientOptions {
  retry?: Partial<RetryPolicy>;
  breaker?: Partial<BreakerPolicy>;
  /** Per-attempt request timeout in ms. Ignored when the caller passes a signal. */
  timeoutMs?: number;
  logger?: HttpClientLogger;
  /** Injectable fetch (tests call with a stub). Defaults to the global fetch. */
  fetchImpl?: FetchImpl;
  /** Injectable rng for jitter, so tests can be deterministic. */
  random?: () => number;
  /** Injectable clock for breaker open/half-open timing. */
  now?: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 0.2,
};

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
};

export const DEFAULT_TIMEOUT_MS = 10_000;

/** Thrown when the breaker is open and the call was refused without network I/O. */
export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `Circuit breaker is open — request refused, retry in ${Math.ceil(retryAfterMs)}ms`,
    );
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** A transient failure worth retrying: 429, 408, any 5xx, or a network error. */
export function isTransientStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Backoff for attempt `attempt` (1-based) — the wait before the next try:
 * base × 2^(attempt-1), capped at maxDelayMs, plus up to jitterRatio×delay of
 * random jitter (which never pushes the total above maxDelayMs either).
 */
export function computeBackoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(
    policy.baseDelayMs * Math.pow(2, attempt - 1),
    policy.maxDelayMs,
  );
  const jitter = exponential * policy.jitterRatio * random();
  return Math.min(exponential + jitter, policy.maxDelayMs);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or null. */
export function parseRetryAfterMs(raw: string | null, now: number): number | null {
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : null;
  }
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(date - now, 0);
}

export type BreakerState = "closed" | "open" | "half-open";

export interface HttpClient {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Current breaker state, for /health surfaces and tests. */
  breakerState(): BreakerState;
  /** Consecutive failed calls observed so far (resets on any success). */
  consecutiveFailures(): number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Translate the validated ./config limits into client options. */
export function optionsFromConfig(cfg?: HttpClientConfig): HttpClientOptions {
  if (!cfg) return {};
  return { retry: cfg.retry, breaker: cfg.breaker, timeoutMs: cfg.timeoutMs };
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const breaker: BreakerPolicy = { ...DEFAULT_BREAKER_POLICY, ...options.breaker };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = options.logger ?? console;
  const doFetch: FetchImpl =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  // ── Circuit breaker state ──────────────────────────────────────────────────
  let failures = 0;
  let openedAt = 0;
  let probeInFlight = false;

  function isOpen(): boolean {
    return failures >= breaker.failureThreshold;
  }

  function state(): BreakerState {
    if (!isOpen()) return "closed";
    return probeInFlight ? "half-open" : "open";
  }

  function recordSuccess(): void {
    if (isOpen() || failures > 0) {
      logger.info(`[http] circuit breaker closed after a successful call`);
    }
    failures = 0;
    probeInFlight = false;
  }

  function recordFailure(): void {
    probeInFlight = false;
    failures++;
    if (failures === breaker.failureThreshold) {
      openedAt = now();
      logger.error(
        `[http] circuit breaker OPEN after ${failures} consecutive failed calls; ` +
          `failing fast for ${breaker.resetTimeoutMs}ms`,
      );
    } else if (isOpen()) {
      // A failed half-open probe: re-open from now and restart the window.
      openedAt = now();
      logger.error(`[http] circuit breaker probe failed — re-opened`);
    }
  }

  /** Throws CircuitOpenError when the breaker must refuse the call. */
  function admit(): void {
    if (!isOpen()) return;
    const remaining = breaker.resetTimeoutMs - (now() - openedAt);
    if (remaining > 0) throw new CircuitOpenError(remaining);
    if (probeInFlight) throw new CircuitOpenError(breaker.resetTimeoutMs);
    probeInFlight = true;
    logger.warn(
      `[http] circuit breaker half-open — allowing one probe call after ${breaker.resetTimeoutMs}ms`,
    );
  }

  /**
   * One logical call: up to retry.maxAttempts network attempts, backing off
   * between them. Throws a clear Error once the retries are exhausted.
   */
  async function callOnce(input: string, init?: RequestInit): Promise<Response> {
    const ownsSignal = init?.signal == null;

    for (let attempt = 1; ; attempt++) {
      const signal = ownsSignal
        ? AbortSignal.timeout(timeoutMs)
        : init!.signal ?? undefined;

      let res: Response | undefined;
      let networkError: unknown;
      try {
        res = await doFetch(input, { ...init, signal });
        if (!isTransientStatus(res.status)) return res;
        // Drain discarded transient responses so the socket can be reused.
        await res.text().catch(() => "");
      } catch (err) {
        // A caller-aborted signal is intent, not a transient failure: surface it.
        if (!ownsSignal && (err as Error)?.name === "AbortError" && init?.signal?.aborted) {
          throw err;
        }
        networkError = err;
      }

      if (attempt >= retry.maxAttempts) {
        const reason =
          networkError != null
            ? `network error: ${(networkError as Error).message}`
            : `HTTP ${res!.status}`;
        throw new Error(
          `${input} failed after ${attempt} attempt${attempt === 1 ? "" : "s"} (${reason}) — ` +
            `upstream is rate-limiting or unhealthy`,
        );
      }

      // Wait: honour Retry-After on 429, otherwise exponential backoff.
      let delayMs = computeBackoffDelayMs(attempt, retry, random);
      if (res != null && res.status === 429) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), now());
        if (retryAfterMs != null) {
          delayMs = Math.max(delayMs, Math.min(retryAfterMs, retry.maxDelayMs));
        }
      }
      logger.warn(
        `[http] attempt ${attempt}/${retry.maxAttempts} for ${input} failed ` +
          `(${networkError != null ? "network error" : `HTTP ${res!.status}`}), ` +
          `retrying in ${Math.round(delayMs)}ms`,
      );
      await sleep(delayMs);
    }
  }

  return {
    async fetch(input: string, init?: RequestInit): Promise<Response> {
      admit();
      try {
        const res = await callOnce(input, init);
        recordSuccess();
        return res;
      } catch (err) {
        if (err instanceof CircuitOpenError) throw err;
        recordFailure();
        throw err;
      }
    },
    breakerState: state,
    consecutiveFailures: () => failures,
  };
}
