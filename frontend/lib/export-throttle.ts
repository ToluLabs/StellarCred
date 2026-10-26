/**
 * Per-tenant rate limiting for export jobs (#788).
 *
 * Uses `checkLimitAsync` from `rate-limit.ts` for the increment path, and
 * `getRateLimitStatus` for the read-only status path (used by metrics).
 *
 * ## Configuration (env vars)
 *
 * | Variable                        | Default | Meaning                                  |
 * |---------------------------------|---------|------------------------------------------|
 * | `EXPORT_RATE_LIMIT_PER_TENANT`  | 10      | Max export jobs per issuer per window    |
 * | `EXPORT_RATE_LIMIT_WINDOW_SECONDS` | 3600 | Rate-limit window in seconds             |
 *
 * ## Key pattern
 *
 * The key passed to `checkLimitAsync` is `export:throttle:<issuer>`, which
 * becomes `rl:export:throttle:<issuer>` inside the KV store because
 * `checkLimitAsync` prepends the `rl:` prefix automatically.
 *
 * The same effective key is referenced by `getRateLimitStatus` directly
 * (without the `rl:` prefix) because the in-process `store` Map already
 * uses the raw key written by `increment`. Since `checkLimitAsync` delegates
 * to `checkLimit` (and thus `increment`) for the MemoryStore, the key stored
 * is `export:throttle:<issuer>` (not `rl:export:throttle:<issuer>`).
 *
 * @module export-throttle
 */

import {
  checkLimitAsync,
  getRateLimitStatus,
  rateLimitClear,
} from "./rate-limit";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Return the current rate-limit configuration for export jobs.
 */
export function getExportRateLimit(): { limit: number; windowMs: number } {
  const limit = readInt("EXPORT_RATE_LIMIT_PER_TENANT", 10);
  const windowMs = readInt("EXPORT_RATE_LIMIT_WINDOW_SECONDS", 3600) * 1000;
  return { limit, windowMs };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Read-only throttle status for a single issuer. */
export interface ThrottleStatus {
  issuer: string;
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check (and record) one export request for `issuer`.
 *
 * Increments the rate-limit counter and returns whether the request is
 * allowed. Call this once per new export job attempt.
 *
 * @returns `{ allowed: true, remaining, resetAt }` when under limit, or
 *          `{ allowed: false, remaining: 0, resetAt }` when throttled.
 */
export async function checkExportThrottle(issuer: string): Promise<{
  allowed: boolean;
  remaining: number;
  resetAt: number;
}> {
  const { limit, windowMs } = getExportRateLimit();
  const key = `export:throttle:${issuer}`;
  const result = await checkLimitAsync(key, limit, windowMs);

  if (result.throttled) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + result.retryAfterMs,
    };
  }

  return {
    allowed: true,
    remaining: result.remaining,
    resetAt: result.windowEnd,
  };
}

/**
 * Read-only throttle status for `issuer` — does NOT increment the counter.
 *
 * This is safe to call from metrics / dashboards where incrementing would
 * consume quota. Uses the in-process `getRateLimitStatus` view.
 */
export async function getExportThrottleStatus(
  issuer: string,
): Promise<ThrottleStatus> {
  const { limit, windowMs } = getExportRateLimit();
  // getRateLimitStatus uses the raw key (no rl: prefix) because the in-process
  // store holds keys as written by increment(), which does NOT prepend rl:.
  // checkLimitAsync delegates to checkLimit (and thus increment) for the
  // MemoryStore, so the stored key is `export:throttle:<issuer>`.
  const key = `export:throttle:${issuer}`;
  const status = getRateLimitStatus(key, limit, windowMs);

  return {
    issuer,
    allowed: !status.throttled,
    remaining: status.remaining,
    resetAt: status.windowEnd,
  };
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

/**
 * Clear the in-process rate-limit store. Call in `afterEach` after also
 * calling `setSharedStoreForTesting(null)` to fully isolate test cases.
 */
export function __resetExportThrottleForTesting(): void {
  rateLimitClear();
}
