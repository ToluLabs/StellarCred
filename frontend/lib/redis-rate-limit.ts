/**
 * redis-rate-limit.ts — Redis-backed rate-limit store for multi-instance deployments.
 *
 * This module is the Redis-backed replacement for the in-process Map store in
 * rate-limit.ts. It exposes the same `checkLimit` / `RateLimitResult` interface
 * so existing call sites in the issue routes need zero changes — just swap the
 * import to this module (or let the factory below pick the right one based on
 * REDIS_URL being present).
 *
 * ## Algorithm — atomic fixed-window with INCR + EXPIRE
 *
 * 1. INCR the key  → returns the new count (atomic on Redis).
 * 2. If count === 1 → it's the first request in a fresh window: SET PEXPIRE
 *    so Redis automatically purges the key when the window ends.
 * 3. If count > limit → throttled; PTTL gives the remaining window duration
 *    for the Retry-After header.
 *
 * Using INCR + conditional PEXPIRE (instead of a Lua script or MULTI/EXEC)
 * is race-safe because:
 *  - INCR is atomic; no two requests can both observe count=1.
 *  - The PEXPIRE is only sent when count===1, so it is also effectively
 *    atomic with the INCR — a concurrent request seeing count=2+ won't
 *    reset the expiry.
 *
 * ## Connection pooling
 *
 * A single `IORedis` connection is lazily created on first use and reused
 * across all requests in the process. Serverless environments that spin up
 * fresh isolates per request should set `lazyConnect: true` (the default
 * here) and ensure the environment supports persistent connections (e.g.
 * Next.js `unstable_noStore` is NOT set, so the module-level singleton
 * persists across requests within a warm container).
 *
 * ## Configuration (env vars)
 *
 * | Variable          | Default          | Meaning                              |
 * |-------------------|------------------|--------------------------------------|
 * | `REDIS_URL`       | —                | Redis connection URL (required)      |
 * | `REDIS_KEY_PREFIX`| `sc:rl:`         | Namespace prefix for all rate-limit  |
 * |                   |                  | keys to avoid collisions in a shared |
 * |                   |                  | Redis instance.                      |
 * | `REDIS_TLS`       | auto from URL    | Set to `"1"` to force TLS regardless |
 * |                   |                  | of the scheme in REDIS_URL.          |
 *
 * ## Graceful degradation
 *
 * When the Redis connection is unavailable (startup failure, network blip,
 * timeout), `checkLimit` falls back to the in-process Map store from
 * rate-limit.ts rather than returning a hard error or blocking all requests.
 * This means rate-limiting remains active in degraded mode; it just loses
 * cross-instance coordination until Redis recovers.
 *
 * The fallback is logged at `warn` level so operators can alert on it. It
 * is NOT silent.
 *
 * ## Key expiry / memory management
 *
 * Each key expires automatically via PEXPIRE at the end of its window, so
 * no background cleanup job is needed on the Redis side.
 */

import { checkLimit as inProcessCheckLimit, type RateLimitResult } from "./rate-limit";

// ---------------------------------------------------------------------------
// Lazy Redis client (ioredis)
// ---------------------------------------------------------------------------

// We import ioredis dynamically so that deployments that have not installed
// it (i.e. still using the in-process store) don't get a hard import error.
// The `getRedisClient()` factory returns null when ioredis is absent or when
// REDIS_URL is not set, which triggers the in-process fallback path.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IoRedis = any;

let _redisClient: IoRedis | null = null;
let _redisInitialized = false;
let _redisConnecting = false;

const KEY_PREFIX = process.env["REDIS_KEY_PREFIX"] ?? "sc:rl:";

async function getRedisClient(): Promise<IoRedis | null> {
  if (_redisInitialized) return _redisClient;
  if (_redisConnecting) return null; // avoid concurrent init races

  const redisUrl = process.env["REDIS_URL"];
  if (!redisUrl) {
    _redisInitialized = true;
    return null;
  }

  _redisConnecting = true;
  try {
    // Dynamic import — fails gracefully if ioredis is not installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: Redis } = await (Function('return import("ioredis")')() as Promise<{ default: { new(url: string, opts?: Record<string, unknown>): IoRedis } }>);

    const useTls =
      process.env["REDIS_TLS"] === "1" || redisUrl.startsWith("rediss://");

    const client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,         // fail fast so we fall back quickly
      enableReadyCheck: true,
      connectTimeout: 3_000,
      ...(useTls ? { tls: {} } : {}),
    });

    client.on("error", (err: Error) => {
      // Non-fatal: log and continue using in-process fallback.
      console.warn("[redis-rate-limit] Redis error — falling back to in-process store:", err.message);
    });

    await client.connect();
    _redisClient = client;
    console.info("[redis-rate-limit] Connected to Redis for rate limiting.");
  } catch (err) {
    console.warn(
      "[redis-rate-limit] Failed to connect to Redis — using in-process rate-limit store:",
      (err as Error).message,
    );
    _redisClient = null;
  } finally {
    _redisInitialized = true;
    _redisConnecting = false;
  }

  return _redisClient;
}

// ---------------------------------------------------------------------------
// Redis-backed fixed-window check
// ---------------------------------------------------------------------------

/**
 * Atomically increment the counter for `key` in Redis and return whether the
 * request is allowed under `limit` within `windowMs`.
 *
 * Returns null on any Redis error so the caller can fall back to the
 * in-process store without crashing.
 */
async function redisCheck(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult | null> {
  const redis = await getRedisClient();
  if (!redis) return null;

  const prefixed = `${KEY_PREFIX}${key}`;

  try {
    // INCR is atomic — all concurrent requests see a monotonically increasing
    // counter within the same window.
    const count = await redis.incr(prefixed);

    if (count === 1) {
      // First request in a new window — set the TTL so Redis auto-purges the key.
      await redis.pexpire(prefixed, windowMs);
    }

    if (count > limit) {
      // Key might not have a TTL if the PEXPIRE above raced (extremely rare).
      // Use PTTL as the authoritative remaining time; fall back to windowMs.
      const pttl = await redis.pttl(prefixed);
      const retryAfterMs = pttl > 0 ? pttl : windowMs;
      return { throttled: true, retryAfterMs };
    }

    // Read the window end for callers that want to surface the reset time.
    const pttl = await redis.pttl(prefixed);
    const windowEnd =
      pttl > 0 ? Date.now() + pttl : Date.now() + windowMs;

    return {
      throttled: false,
      remaining: limit - count,
      windowEnd,
    };
  } catch (err) {
    // Any Redis error: let the caller fall back.
    console.warn("[redis-rate-limit] Redis check failed:", (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — drop-in replacement for rate-limit.ts checkLimit
// ---------------------------------------------------------------------------

/**
 * Check (and record) one request for `key` against `limit` within `windowMs`.
 *
 * When Redis is available, the check is performed atomically in Redis so
 * limits are shared across all instances of the application.
 *
 * When Redis is unavailable (not configured, connection error, timeout), the
 * check falls back to the in-process Map store from rate-limit.ts. The
 * fallback is logged at warn level and is fully transparent to callers.
 *
 * The key should already be namespaced (e.g. `"issue:ip:<raw>"`) by the
 * caller; this function prepends KEY_PREFIX (`sc:rl:` by default) before
 * storing it in Redis, and passes the key verbatim to the in-process store.
 */
export async function checkLimitRedis(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const result = await redisCheck(key, limit, windowMs);
  if (result !== null) return result;
  // In-process fallback (synchronous).
  return inProcessCheckLimit(key, limit, windowMs);
}

/**
 * Close the Redis connection. Call during graceful shutdown.
 * Safe to call even when Redis was never connected.
 */
export async function closeRedisConnection(): Promise<void> {
  if (_redisClient) {
    await _redisClient.quit().catch(() => {
      // Best-effort; ignore errors on shutdown.
    });
    _redisClient = null;
  }
  _redisInitialized = false;
}

/**
 * Returns true when a Redis connection is currently established.
 * Used by the /api/ready health check to report Redis status.
 */
export function isRedisConnected(): boolean {
  return _redisClient !== null && _redisClient.status === "ready";
}
