/**
 * Global concurrency cap for export download jobs (#788).
 *
 * Tracks the number of currently active export jobs using a counter stored
 * under `export:concurrency:active` in the shared KV store. The cap is read
 * from `EXPORT_MAX_CONCURRENT_JOBS` (default 5).
 *
 * ## Algorithm — incr-then-check
 *
 * `acquireConcurrencySlot` increments the counter first, then checks whether
 * the resulting value exceeds the cap. If it does, the increment is rolled
 * back (get + set(count - 1)) and `false` is returned. This is consistent
 * with how `checkLimitAsync` works in `rate-limit.ts`.
 *
 * ## TOCTOU limitation
 *
 * Under `UpstashRedisStore` (multi-instance deploys), two concurrent
 * `acquireConcurrencySlot` calls can both increment the counter and both see
 * a value ≤ cap before either rolls back, allowing more than `cap` concurrent
 * jobs to proceed simultaneously. This is acceptable for the current
 * deployment model — the same limitation applies to the existing rate-limiter
 * module. The counter will self-correct as slots are released.
 *
 * Under `MemoryStore` (single process), Node.js's single-threaded event loop
 * ensures no interleaving of synchronous reads and writes, so the cap is
 * exact.
 *
 * @module export-concurrency
 */

import { getSharedStore } from "./shared-store";

const CONCURRENCY_KEY = "export:concurrency:active";

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
 * Return the maximum number of simultaneously active export jobs.
 * Reads `EXPORT_MAX_CONCURRENT_JOBS` from env (default 5).
 */
export function getMaxConcurrentJobs(): number {
  return readInt("EXPORT_MAX_CONCURRENT_JOBS", 5);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to acquire one concurrency slot.
 *
 * Uses an incr-then-check pattern: increments the counter unconditionally,
 * then rolls back if the result exceeds the cap. Returns `true` when a slot
 * was acquired and `false` when the cap has been reached.
 *
 * **TOCTOU note**: under `UpstashRedisStore`, concurrent calls from multiple
 * instances can both pass the cap check before either rolls back. See module
 * JSDoc for details.
 */
export async function acquireConcurrencySlot(): Promise<boolean> {
  const cap = getMaxConcurrentJobs();
  const store = getSharedStore();

  // incr atomically (within MemoryStore; best-effort on UpstashRedisStore).
  const { count } = await store.incr(CONCURRENCY_KEY);

  if (count > cap) {
    // Roll back: read the current value and decrement by 1.
    try {
      const raw = await store.get(CONCURRENCY_KEY);
      const current = raw !== null ? parseInt(raw, 10) : 0;
      const next = Math.max(0, current - 1);
      await store.set(CONCURRENCY_KEY, String(next));
    } catch (err) {
      console.warn("[export-concurrency] Failed to roll back concurrency counter:", err);
    }
    return false;
  }

  return true;
}

/**
 * Release one concurrency slot.
 *
 * Reads the current counter and sets it to `count - 1` (clamped at 0).
 * Best-effort: errors are swallowed with `console.warn`.
 */
export async function releaseConcurrencySlot(): Promise<void> {
  const store = getSharedStore();
  try {
    const raw = await store.get(CONCURRENCY_KEY);
    const current = raw !== null ? parseInt(raw, 10) : 0;
    if (current <= 0) return; // already at 0 — no-op
    await store.set(CONCURRENCY_KEY, String(current - 1));
  } catch (err) {
    console.warn("[export-concurrency] Failed to release concurrency slot:", err);
  }
}

/**
 * Return the current number of active export jobs.
 * Returns 0 if the key is missing or the value cannot be parsed.
 */
export async function getActiveConcurrency(): Promise<number> {
  const store = getSharedStore();
  const raw = await store.get(CONCURRENCY_KEY);
  if (raw === null) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

/**
 * Reset the concurrency counter to zero. Callers must also call
 * `setSharedStoreForTesting(new MemoryStore())` for full isolation.
 */
export function __resetConcurrencyForTesting(): void {
  const store = getSharedStore();
  store.set(CONCURRENCY_KEY, "0").catch(() => {
    // best-effort — if no store is configured the caller's
    // setSharedStoreForTesting(new MemoryStore()) already wiped state
  });
}
