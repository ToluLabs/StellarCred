/**
 * Per-IP and per-wallet rate limiting for the API routes.
 *
 * ## Algorithm — fixed window with request count
 *
 * Each (key, window) pair is a counter: how many requests have arrived in the
 * current fixed-time window.  When the counter reaches the limit, further
 * requests are rejected with a 429 and a `Retry-After` header pointing to the
 * end of the window.
 *
 * A fixed window is chosen over a sliding-log because it is O(1) in both time
 * and memory per key, which is important for an in-memory store that lives in
 * the same process as the application.
 *
 * ## Key extraction
 *
 * - **IP** — read in order: `x-forwarded-for` (first value), `x-real-ip`,
 *   `cf-connecting-ip` (Cloudflare), then fall back to `"unknown"`. Never
 *   logged verbatim; only a SHA-256–truncated token appears in log events.
 * - **Wallet address** — callers supply this from the already-parsed body.
 *   It is never logged; same hashed token approach.
 *
 * Both are hashed before any log line is written so PII never enters the log
 * pipeline. The raw values are used only for the in-process Map lookup.
 *
 * ## Configuration (env vars)
 *
 * | Variable                        | Default | Meaning                                 |
 * |---------------------------------|---------|-----------------------------------------|
 * | `RATE_LIMIT_ISSUE_IP`           | 20      | max issue requests per IP per window    |
 * | `RATE_LIMIT_ISSUE_WALLET`       | 10      | max issue requests per wallet per window|
 * | `RATE_LIMIT_WITNESS_IP`         | 60      | max witness requests per IP per window  |
 * | `RATE_LIMIT_PLAID_IP`           | 30      | max plaid-balance requests per IP/window|
 * | `RATE_LIMIT_WINDOW_SECONDS`     | 60      | window length in seconds (all routes)   |
 *
 * ## Multi-instance / serverless deploy note
 *
 * This store is **in-process only**.  On a single long-lived server (PM2,
 * Docker single replica, Railway single instance) it is fully effective.
 *
 * On **serverless / edge** targets (Vercel Functions, AWS Lambda, Cloudflare
 * Workers) each invocation may run in a separate isolate that starts with an
 * empty store, making per-process counters ineffective across concurrent cold
 * starts.  For those deployments you should replace this module with a shared
 * atomic counter backed by a low-latency store, for example:
 *
 *   - **Upstash Redis** (`@upstash/ratelimit` + `@upstash/redis`) — the
 *     `FixedWindow` algorithm maps directly to what this module implements.
 *     Replace the `checkLimit` call sites with `ratelimit.limit(key)`.
 *   - **Vercel KV** (same Upstash backend, zero config in Vercel projects).
 *   - **Redis (ioredis / node-redis)** — INCR + EXPIRE or a Lua script for
 *     atomic fixed-window counting.
 *   - **DynamoDB conditional writes** — viable on AWS Lambda when you already
 *     pay for DynamoDB.
 *
 * The interface exposed here (`checkLimit`, `RateLimitResult`) is intentionally
 * thin so swapping the backing store requires changing only this file.
 */

import { createHash } from "crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Limits for each protected route. Resolved once at module load. */
export const LIMITS = {
  /** Max requests per IP per window on /api/issue. */
  issuePerIp: () => readInt("RATE_LIMIT_ISSUE_IP", 20),
  /** Max requests per wallet per window on /api/issue. */
  issuePerWallet: () => readInt("RATE_LIMIT_ISSUE_WALLET", 10),
  /** Max requests per IP per window on /api/witness. */
  witnessPerIp: () => readInt("RATE_LIMIT_WITNESS_IP", 60),
  /** Max requests per IP per window on /api/plaid-balance. */
  plaidPerIp: () => readInt("RATE_LIMIT_PLAID_IP", 30),
  /** Window duration in milliseconds (shared by all routes). */
  windowMs: () => readInt("RATE_LIMIT_WINDOW_SECONDS", 60) * 1000,
} as const;

// ---------------------------------------------------------------------------
// In-process store
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  /** Timestamp (Date.now()) at which this window expires. */
  windowEnd: number;
}

// Single shared map for all keys (namespaced by a route prefix + key).
const store = new Map<string, Bucket>();

/**
 * Increment the counter for `storeKey` and return whether the request is
 * allowed.  Creates a new window when none exists or the current one has
 * expired.
 *
 * Returns `{ allowed: true }` when under the limit, or
 * `{ allowed: false, retryAfterMs }` when the limit is exceeded.
 *
 * @internal Use {@link checkLimit} at call sites.
 */
function increment(
  storeKey: string,
  limit: number,
  windowMs: number,
): { allowed: true; remaining: number; windowEnd: number } | { allowed: false; retryAfterMs: number } {
  const now = Date.now();
  let bucket = store.get(storeKey);

  if (!bucket || now >= bucket.windowEnd) {
    // New window — reset counter.
    bucket = { count: 1, windowEnd: now + windowMs };
    store.set(storeKey, bucket);
    return { allowed: true, remaining: limit - 1, windowEnd: bucket.windowEnd };
  }

  bucket.count += 1;

  if (bucket.count > limit) {
    return { allowed: false, retryAfterMs: bucket.windowEnd - now };
  }

  return { allowed: true, remaining: limit - bucket.count, windowEnd: bucket.windowEnd };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RateLimitResult =
  | { throttled: false; remaining: number; windowEnd: number }
  | { throttled: true; retryAfterMs: number };

/**
 * Check (and record) one request for `key` against `limit` within `windowMs`.
 *
 * The key should already be namespaced (e.g. `"issue:ip:<raw>"`) by the
 * caller; this function stores it verbatim.  Keys are never logged by this
 * module.
 */
export function checkLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const result = increment(key, limit, windowMs);
  if (!result.allowed) {
    return { throttled: true, retryAfterMs: result.retryAfterMs };
  }
  return { throttled: false, remaining: result.remaining, windowEnd: result.windowEnd };
}

// ---------------------------------------------------------------------------
// Read-only status (self-serve usage view)
// ---------------------------------------------------------------------------

/**
 * Current usage of `key` against `limit` within `windowMs` — read-only.
 *
 * Returns the same numbers the request path would report, WITHOUT recording a
 * request or mutating the store. This is what powers the self-serve issuer
 * usage dashboard (/api/usage): polling it to check where you stand must not
 * itself consume quota, otherwise merely looking at the dashboard would edge
 * you closer to a 429.
 *
 * The key should already be namespaced (e.g. `"issue:wallet:<raw>"`); it is
 * stored verbatim and never logged.
 */
export interface RateLimitStatus {
  /** Requests already counted in the current window for this key. */
  used: number;
  /** Maximum requests allowed per window for this key. */
  limit: number;
  /** Requests still permitted before a 429 in the current window. */
  remaining: number;
  /** True when the window is exhausted (a further request would be rejected). */
  throttled: boolean;
  /** Absolute ms timestamp (Date.now()) at which the current window resets. */
  windowEnd: number;
  /** Whole seconds until `windowEnd` — the reset timing for the UI. */
  resetSeconds: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * Inspect current usage for `key` (see {@link RateLimitStatus}) without
 * recording anything. A key with no live bucket — or only an expired one —
 * reports an untouched window (`used: 0`) whose reset is one full window
 * length away.
 */
export function getRateLimitStatus(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitStatus {
  const now = Date.now();
  const bucket = store.get(key);
  const expired = !bucket || now >= bucket.windowEnd;

  const used = expired ? 0 : bucket.count;
  const windowEnd = expired ? now + windowMs : bucket.windowEnd;
  const remaining = expired ? limit : Math.max(0, limit - used);
  const resetSeconds = Math.max(
    used > 0 ? 1 : Math.ceil(windowMs / 1000),
    Math.ceil((windowEnd - now) / 1000),
  );

  return {
    used,
    limit,
    remaining,
    throttled: used >= limit,
    windowEnd,
    resetSeconds,
    windowMs,
  };
}

// ---------------------------------------------------------------------------
// IP extraction
// ---------------------------------------------------------------------------

/**
 * Extract the best-effort client IP from a Next.js request.
 *
 * Reads, in order:
 *   1. `x-forwarded-for` — the first (leftmost) address, which is the
 *      original client IP when the proxy prepends rather than replaces.
 *   2. `x-real-ip` — set by nginx by default.
 *   3. `cf-connecting-ip` — set by Cloudflare.
 *
 * Falls back to `"unknown"` when none is present (e.g. in test environments).
 * The returned string is the raw IP, suitable for use as a Map key.  It is
 * never written to any log.
 */
export function extractIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  return "unknown";
}

// ---------------------------------------------------------------------------
// PII-safe logging token
// ---------------------------------------------------------------------------

/**
 * Return the first 8 hex characters of `SHA-256(value)` for use in log
 * events.  Sufficient to correlate log lines within a session without
 * exposing the actual IP or wallet address.
 */
export function hashForLog(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// 429 response builder
// ---------------------------------------------------------------------------

/**
 * Build a `429 Too Many Requests` response with `Retry-After` (seconds,
 * rounded up) and `X-RateLimit-Reset` (Unix epoch seconds) headers.
 */
export function tooManyRequestsResponse(retryAfterMs: number): NextResponse {
  const retryAfterSecs = Math.ceil(retryAfterMs / 1000);
  const resetEpoch = Math.ceil((Date.now() + retryAfterMs) / 1000);
  return NextResponse.json(
    {
      error: "Too many requests. Please slow down.",
      code: "rate_limited",
      retryAfterSeconds: retryAfterSecs,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSecs),
        "X-RateLimit-Reset": String(resetEpoch),
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Store management (testing / maintenance)
// ---------------------------------------------------------------------------

/** Clear the entire rate-limit store.  Only for tests. */
export function rateLimitClear(): void {
  store.clear();
}

/** Return the current number of tracked buckets.  Only for tests. */
export function rateLimitSize(): number {
  return store.size;
}

/**
 * Evict all buckets whose window has already expired.
 * Call periodically (e.g. from a background interval or a maintenance route)
 * to prevent unbounded memory growth on high-traffic deployments.
 */
export function rateLimitCleanup(): void {
  const now = Date.now();
  for (const [key, bucket] of store) {
    if (now >= bucket.windowEnd) {
      store.delete(key);
    }
  }
}
