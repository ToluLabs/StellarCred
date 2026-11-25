// @stellarcred/sdk — automatic RPC failover for Soroban and Horizon nodes (#1058)
//
// Outages, timeouts, or rate limits on a single public RPC node cause all
// client-side verification and query requests to fail immediately. This module
// manages prioritized lists of Soroban and Horizon endpoints, tracking per-node
// health and automatically failing over to the next healthy endpoint on
// timeouts, HTTP 5xx responses, HTTP 429 rate limits, or network errors.
//
// Terminal / application errors (invalid arguments, HTTP 4xx other than 408/429,
// contract panics, or caller aborts) are rethrown immediately without marking
// the node unhealthy or trying fallback nodes.
//
// This module has no dependency on `@stellar/stellar-sdk` so it remains
// lightweight and tree-shakeable.

import { abortReason } from "./backoff";
import { ContractError, RpcError } from "./errors";

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

/** Default duration (ms) an unhealthy node stays in cooldown before re-probing. */
export const DEFAULT_FAILOVER_COOLDOWN_MS = 30_000;

/** Default consecutive failover-eligible failures before a node enters cooldown. */
export const DEFAULT_FAILOVER_THRESHOLD = 1;

/** Which Stellar node tier a failover pool targets. */
export type RpcNodeKind = "soroban" | "horizon";

/** Reason a failover transition was triggered. */
export type RpcFailoverReason = "timeout" | "server_error" | "rate_limited" | "network_error";

/** Diagnostic event emitted whenever execution fails over to the next endpoint. */
export interface RpcFailoverEvent {
  /** Whether the failover occurred on the Soroban RPC pool or Horizon pool. */
  kind: RpcNodeKind;
  /** Endpoint URL that failed. */
  fromUrl: string;
  /** Next endpoint URL being tried. */
  toUrl: string;
  /** Classified reason for failing over. */
  reason: RpcFailoverReason;
  /** HTTP status code when available (e.g. 502, 503, 504, 429, 408). */
  statusCode?: number;
  /** Underlying error thrown by `fromUrl`. */
  error: unknown;
  /** 1-based failover count within the current operation. */
  attempt: number;
}

/** Configuration for {@link RpcFailoverPool} and `configure({ failover })`. */
export interface RpcFailoverOptions {
  /**
   * Milliseconds an unhealthy endpoint stays in cooldown before it is probed
   * again as a higher-priority candidate. Default: 30 000 ms. Set to `0` to
   * always probe in strict priority order on every call.
   */
  cooldownMs?: number;
  /**
   * Consecutive failover-eligible failures required before an endpoint is
   * placed in cooldown. Default: 1 (fail over immediately on first outage).
   */
  failureThreshold?: number;
  /**
   * Optional callback invoked whenever execution fails over from one endpoint
   * to the next. Errors thrown by this callback are swallowed so logging hooks
   * can never disrupt failover.
   */
  onFailover?: (event: RpcFailoverEvent) => void;
  /**
   * Clock source returning epoch milliseconds. Defaults to `Date.now`; exposed
   * primarily for deterministic unit tests.
   */
  now?: () => number;
}

/** Point-in-time health snapshot for a single configured endpoint. */
export interface RpcEndpointHealth {
  url: string;
  /** 0-based priority index (0 is primary). */
  priority: number;
  /** True when the endpoint is not currently in cooldown. */
  healthy: boolean;
  /** Number of consecutive failover-eligible failures recorded. */
  consecutiveFailures: number;
  /** Epoch ms of the most recent failure, or `null` if none recorded. */
  lastFailureAt: number | null;
  /** Epoch ms when cooldown expires, or `null` when healthy. */
  cooldownUntil: number | null;
  /** Reason for the most recent failure, or `null` when healthy. */
  lastErrorReason: RpcFailoverReason | null;
  /** Epoch ms of the most recent successful call, or `null` if none yet. */
  lastSuccessAt: number | null;
}

/** Metadata passed to each attempt inside {@link RpcFailoverPool.execute}. */
export interface RpcFailoverAttemptMeta {
  /** Endpoint URL selected for this attempt. */
  url: string;
  /** 0-based attempt index within this failover pass. */
  attempt: number;
  /** Original 0-based priority index of `url` in the pool. */
  endpointIndex: number;
}

/** Per-call options for {@link RpcFailoverPool.execute}. */
export interface RpcFailoverExecuteOptions {
  /** Abort signal that cancels failover immediately when aborted. */
  signal?: AbortSignal;
  /** Per-call failover hook (invoked in addition to the pool-level hook). */
  onFailover?: (event: RpcFailoverEvent) => void;
}

/** Options for {@link fetchWithFailover} / `fetchHorizon`. */
export interface HorizonFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal;
  /** Per-endpoint timeout in milliseconds. Default: 10 000 ms. */
  timeoutMs?: number;
  /** Custom `fetch` implementation (useful in tests or custom runtimes). */
  fetchImpl?: typeof fetch;
  /** Per-call failover hook. */
  onFailover?: (event: RpcFailoverEvent) => void;
}

// ---------------------------------------------------------------------------
// URL normalization & env parsing
// ---------------------------------------------------------------------------

/** Validate that `url` is a well-formed `http:` or `https:` URL. */
export function isValidHttpEndpointUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Trim, validate, and deduplicate a prioritized list of HTTP(S) endpoint URLs
 * while preserving order. Throws a plain `Error` if any entry is invalid.
 */
export function normalizeEndpointUrls(urls: readonly string[], label = "rpcUrls"): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of urls) {
    if (typeof raw !== "string") {
      throw new Error(`${label} entries must be strings`);
    }
    const trimmed = raw.trim();
    if (!isValidHttpEndpointUrl(trimmed)) {
      throw new Error(`${label} contains an invalid HTTP(S) URL: "${raw}"`);
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }

  return normalized;
}

/**
 * Parse a comma-separated list of endpoint URLs from an environment variable.
 * Empty segments are ignored.
 */
export function parseEndpointListEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

const NON_FAILOVER_ERROR_NAMES = new Set([
  "ConfigError",
  "InvalidAddressError",
  "InvalidClaimTypeError",
  "InvalidIssuerError",
  "InvalidThresholdError",
]);

const TIMEOUT_PATTERNS = [
  "timed out",
  "timeout",
  "etimedout",
  "esockettimedout",
  "gateway timeout",
  "request timeout",
];

const RATE_LIMIT_PATTERNS = ["too many requests", "rate limit", "rate-limit", "429"];

const SERVER_ERROR_PATTERNS = [
  "internal server error",
  "bad gateway",
  "service unavailable",
  "http 500",
  "http 502",
  "http 503",
  "status 500",
  "status 502",
  "status 503",
  "status code 500",
  "status code 502",
  "status code 503",
];

const NETWORK_ERROR_PATTERNS = [
  "failed to fetch",
  "fetch failed",
  "networkerror",
  "network request failed",
  "network error",
  "load failed",
  "econnrefused",
  "econnreset",
  "econnaborted",
  "enotfound",
  "eai_again",
  "socket hang up",
  "socket closed",
  "connection reset",
];

const CLIENT_ERROR_PATTERNS = ["invalid argument", "bad request", "parse error"];

function extractHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.status === "number" && Number.isFinite(candidate.status)) {
    return candidate.status;
  }
  if (typeof candidate.statusCode === "number" && Number.isFinite(candidate.statusCode)) {
    return candidate.statusCode;
  }
  if (candidate.response && typeof candidate.response === "object") {
    const resp = candidate.response as Record<string, unknown>;
    if (typeof resp.status === "number" && Number.isFinite(resp.status)) {
      return resp.status;
    }
  }
  if (typeof candidate.message === "string") {
    const match = candidate.message.match(/\b(?:http|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/i);
    if (match) {
      const code = Number(match[1]);
      if (code >= 100 && code <= 599) return code;
    }
  }
  return undefined;
}

/**
 * Inspect an error thrown by an RPC or Horizon request and determine whether
 * it should trigger failover to the next healthy node.
 *
 * Returns a `{ reason, statusCode? }` descriptor for failover-eligible errors
 * (timeouts, HTTP 5xx, HTTP 429, HTTP 408, network/connection failures) and
 * `null` for terminal/application errors (contract panics, validation errors,
 * non-transient HTTP 4xx).
 */
export function classifyFailoverFailure(
  error: unknown,
): { reason: RpcFailoverReason; statusCode?: number } | null {
  if (error instanceof ContractError) {
    return null;
  }

  if (error instanceof RpcError && error.contractError !== undefined) {
    return null;
  }

  if (error instanceof Error && NON_FAILOVER_ERROR_NAMES.has(error.name)) {
    return null;
  }

  const status = extractHttpStatus(error);
  if (status !== undefined) {
    if (status === 429) {
      return { reason: "rate_limited", statusCode: 429 };
    }
    if (status === 408 || status === 504) {
      return { reason: "timeout", statusCode: status };
    }
    if (status >= 500 && status < 600) {
      return { reason: "server_error", statusCode: status };
    }
    if (status >= 400 && status < 500) {
      return null;
    }
  }

  const name = error instanceof Error ? error.name : "";
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === "string"
        ? error.toLowerCase()
        : "";

  if (name === "ReadTimeoutError" || name === "TimeoutError") {
    return { reason: "timeout" };
  }

  if (CLIENT_ERROR_PATTERNS.some((p) => message.includes(p))) {
    return null;
  }

  if (TIMEOUT_PATTERNS.some((p) => message.includes(p))) {
    return { reason: "timeout" };
  }

  if (RATE_LIMIT_PATTERNS.some((p) => message.includes(p))) {
    return { reason: "rate_limited", statusCode: 429 };
  }

  if (SERVER_ERROR_PATTERNS.some((p) => message.includes(p))) {
    return { reason: "server_error", statusCode: status };
  }

  if (NETWORK_ERROR_PATTERNS.some((p) => message.includes(p))) {
    return { reason: "network_error" };
  }

  // Generic RpcError or unknown network-layer Error without a 4xx status.
  if (error instanceof RpcError || error instanceof Error) {
    return { reason: "network_error" };
  }

  return { reason: "network_error" };
}

// ---------------------------------------------------------------------------
// Internal per-endpoint state
// ---------------------------------------------------------------------------

interface EndpointState {
  readonly url: string;
  readonly priority: number;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  cooldownUntil: number | null;
  lastErrorReason: RpcFailoverReason | null;
  lastSuccessAt: number | null;
}

// ---------------------------------------------------------------------------
// RpcFailoverPool
// ---------------------------------------------------------------------------

/**
 * Manages a prioritized list of RPC (Soroban or Horizon) endpoints with
 * per-node health tracking, cooldown recovery, and automatic failover.
 */
export class RpcFailoverPool {
  readonly kind: RpcNodeKind;
  private readonly endpoints: EndpointState[];
  private readonly endpointMap: Map<string, EndpointState>;
  private readonly cooldownMs: number;
  private readonly failureThreshold: number;
  private readonly onFailover?: (event: RpcFailoverEvent) => void;
  private readonly now: () => number;

  constructor(
    urls: readonly string[],
    kind: RpcNodeKind = "soroban",
    options: RpcFailoverOptions = {},
  ) {
    const normalized = normalizeEndpointUrls(urls, kind === "horizon" ? "horizonUrls" : "rpcUrls");
    if (normalized.length === 0) {
      throw new Error(`RpcFailoverPool (${kind}) requires at least one valid endpoint URL`);
    }

    const cooldownMs = options.cooldownMs ?? DEFAULT_FAILOVER_COOLDOWN_MS;
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new Error(`failover.cooldownMs must be a non-negative number, got ${cooldownMs}`);
    }

    const failureThreshold = options.failureThreshold ?? DEFAULT_FAILOVER_THRESHOLD;
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
      throw new Error(
        `failover.failureThreshold must be a positive integer, got ${failureThreshold}`,
      );
    }

    this.kind = kind;
    this.cooldownMs = cooldownMs;
    this.failureThreshold = failureThreshold;
    this.onFailover = options.onFailover;
    this.now = options.now ?? (() => Date.now());

    this.endpoints = normalized.map((url, priority) => ({
      url,
      priority,
      consecutiveFailures: 0,
      lastFailureAt: null,
      cooldownUntil: null,
      lastErrorReason: null,
      lastSuccessAt: null,
    }));
    this.endpointMap = new Map(this.endpoints.map((ep) => [ep.url, ep]));
  }

  /** Configured endpoints in priority order (index 0 is primary). */
  getEndpoints(): readonly string[] {
    return this.endpoints.map((ep) => ep.url);
  }

  /**
   * Returns the highest-priority currently healthy endpoint URL, or the
   * least-recently-failed endpoint if every node is in cooldown.
   */
  getActiveUrl(): string {
    return this.getOrderedCandidates()[0] ?? this.endpoints[0].url;
  }

  /**
   * Computes the ordered list of candidate URLs to try for the next request:
   * 1. Healthy endpoints (including any whose cooldown has expired), in
   *    configured priority order.
   * 2. If all endpoints are currently in cooldown, returns all endpoints
   *    ordered by earliest `cooldownUntil` (least-recently-failed first),
   *    tie-broken by configured priority so a global blip never locks out
   *    the client.
   */
  getOrderedCandidates(): string[] {
    const current = this.now();
    const healthy: EndpointState[] = [];
    const cooling: EndpointState[] = [];

    for (const ep of this.endpoints) {
      if (ep.cooldownUntil !== null && ep.cooldownUntil > current) {
        cooling.push(ep);
      } else {
        healthy.push(ep);
      }
    }

    if (healthy.length > 0) {
      return healthy.map((ep) => ep.url);
    }

    // All nodes are in cooldown: try the ones closest to recovery first.
    return [...cooling]
      .sort((a, b) => {
        const diff = (a.cooldownUntil ?? 0) - (b.cooldownUntil ?? 0);
        return diff !== 0 ? diff : a.priority - b.priority;
      })
      .map((ep) => ep.url);
  }

  /** Read-only snapshot of every endpoint's current health state. */
  getHealthSnapshot(): RpcEndpointHealth[] {
    const current = this.now();
    return this.endpoints.map((ep) => {
      const inCooldown = ep.cooldownUntil !== null && ep.cooldownUntil > current;
      return {
        url: ep.url,
        priority: ep.priority,
        healthy: !inCooldown,
        consecutiveFailures: ep.consecutiveFailures,
        lastFailureAt: ep.lastFailureAt,
        cooldownUntil: inCooldown ? ep.cooldownUntil : null,
        lastErrorReason: ep.lastErrorReason,
        lastSuccessAt: ep.lastSuccessAt,
      };
    });
  }

  /** Explicitly mark an endpoint healthy and clear its cooldown. */
  markHealthy(url: string): void {
    const ep = this.endpointMap.get(url);
    if (!ep) return;
    ep.consecutiveFailures = 0;
    ep.cooldownUntil = null;
    ep.lastErrorReason = null;
    ep.lastSuccessAt = this.now();
  }

  /** Record a failover-eligible failure against `url`. */
  markUnhealthy(url: string, reason: RpcFailoverReason = "network_error"): void {
    const ep = this.endpointMap.get(url);
    if (!ep) return;
    const current = this.now();
    ep.consecutiveFailures += 1;
    ep.lastFailureAt = current;
    ep.lastErrorReason = reason;
    if (ep.consecutiveFailures >= this.failureThreshold && this.cooldownMs > 0) {
      ep.cooldownUntil = current + this.cooldownMs;
    }
  }

  /** Reset health and cooldown state for every endpoint in the pool. */
  resetHealth(): void {
    for (const ep of this.endpoints) {
      ep.consecutiveFailures = 0;
      ep.lastFailureAt = null;
      ep.cooldownUntil = null;
      ep.lastErrorReason = null;
      ep.lastSuccessAt = null;
    }
  }

  /**
   * Execute `operation` against the pool's ordered candidates, failing over
   * automatically to the next healthy node on timeout, HTTP 5xx, HTTP 429, or
   * network errors.
   */
  async execute<T>(
    operation: (url: string, meta: RpcFailoverAttemptMeta) => Promise<T>,
    opts?: RpcFailoverExecuteOptions,
  ): Promise<T> {
    const signal = opts?.signal;
    const candidates = this.getOrderedCandidates();
    let lastError: unknown;
    let failoverCount = 0;

    for (let i = 0; i < candidates.length; i++) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }

      const url = candidates[i];
      const ep = this.endpointMap.get(url);
      const endpointIndex = ep ? ep.priority : i;

      try {
        const result = await operation(url, {
          url,
          attempt: i,
          endpointIndex,
        });
        this.markHealthy(url);
        return result;
      } catch (error: unknown) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }

        const classified = classifyFailoverFailure(error);
        if (!classified) {
          // Terminal / client / contract error — do not penalize node or failover.
          throw error;
        }

        this.markUnhealthy(url, classified.reason);
        lastError = error;

        const nextUrl = candidates[i + 1];
        if (nextUrl) {
          failoverCount += 1;
          const event: RpcFailoverEvent = {
            kind: this.kind,
            fromUrl: url,
            toUrl: nextUrl,
            reason: classified.reason,
            statusCode: classified.statusCode,
            error,
            attempt: failoverCount,
          };
          this.emitFailover(event, opts?.onFailover);
        }
      }
    }

    throw lastError;
  }

  private emitFailover(
    event: RpcFailoverEvent,
    callHook?: (event: RpcFailoverEvent) => void,
  ): void {
    if (this.onFailover) {
      try {
        this.onFailover(event);
      } catch {
        // Logging hooks must never disrupt failover.
      }
    }
    if (callHook) {
      try {
        callHook(event);
      } catch {
        // Logging hooks must never disrupt failover.
      }
    }
  }
}

/** Factory helper for creating an {@link RpcFailoverPool}. */
export function createRpcFailoverPool(
  urls: readonly string[],
  kind: RpcNodeKind = "soroban",
  options?: RpcFailoverOptions,
): RpcFailoverPool {
  return new RpcFailoverPool(urls, kind, options);
}

// ---------------------------------------------------------------------------
// HTTP / Horizon failover helper
// ---------------------------------------------------------------------------

function joinEndpointPath(baseUrl: string, path: string): string {
  if (!path) return baseUrl;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${normalizedPath}`;
}

/**
 * Perform an HTTP `fetch` against a prioritized {@link RpcFailoverPool}
 * (typically Horizon nodes).
 *
 * Automatically fails over to the next healthy node on:
 * - request timeout (`timeoutMs`),
 * - HTTP 5xx responses,
 * - HTTP 429 (rate limited) and HTTP 408 (request timeout),
 * - network / socket failures.
 *
 * Returns the `Response` directly on `2xx`, `3xx`, and non-transient `4xx`
 * responses (e.g. `404 Not Found` for an unfunded account).
 */
export async function fetchWithFailover(
  pool: RpcFailoverPool,
  path: string,
  opts: HorizonFetchOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new RpcError("No global fetch implementation available for Horizon request");
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;

  return pool.execute(
    async (baseUrl) => {
      const targetUrl = joinEndpointPath(baseUrl, path);
      const controller = new AbortController();
      let timedOut = false;

      const onCallerAbort = () => controller.abort(opts.signal?.reason);
      if (opts.signal) {
        if (opts.signal.aborted) {
          throw abortReason(opts.signal);
        }
        opts.signal.addEventListener("abort", onCallerAbort, { once: true });
      }

      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetchImpl(targetUrl, {
          method: opts.method ?? "GET",
          headers: opts.headers,
          body: opts.body,
          signal: controller.signal,
        });

        if (response.status >= 500 || response.status === 429 || response.status === 408) {
          throw new RpcError(
            `${pool.kind === "horizon" ? "Horizon" : "RPC"} request failed with HTTP ${response.status} for ${targetUrl}`,
            { status: response.status },
          );
        }

        return response;
      } catch (err: unknown) {
        if (opts.signal?.aborted) {
          throw abortReason(opts.signal);
        }
        if (timedOut) {
          const timeoutErr = new RpcError(
            `${pool.kind === "horizon" ? "Horizon" : "RPC"} request timed out after ${timeoutMs}ms for ${targetUrl}`,
            { cause: err },
          );
          throw timeoutErr;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
    {
      signal: opts.signal,
      onFailover: opts.onFailover,
    },
  );
}
