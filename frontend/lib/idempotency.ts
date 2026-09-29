/**
 * In-memory idempotency store for the /api/issue endpoint.
 *
 * Design:
 * - Stores opaque key → serialized response (status, body, headers) with a TTL.
 * - The key is an opaque ID from the `Idempotency-Key` header; the store itself
 *   tracks no identity fields (no userId, no walletAddress, no PII).
 * - Keys are validated before use (non-empty, printable, ≤ MAX_KEY_LENGTH_BYTES)
 *   so a hostile oversized header cannot cause memory amplification.
 * - Expired entries are lazily purged on access and periodically during sets.
 * - An in-flight sentinel de-duplicates *concurrent* requests that share the
 *   same key: the first request becomes the leader and any duplicate that
 *   arrives while it is still running awaits its result instead of re-executing
 *   external provider calls (Persona, Plaid) or signing.
 *
 * Scope / known limitation:
 * - This is an in-process store. It guarantees at-most-once execution within a
 *   single server instance/process. In a horizontally scaled deployment with
 *   multiple replicas (Kubernetes, ECS, Vercel serverless concurrency, …), a
 *   retry that is load-balanced to a different replica will not hit this store,
 *   so the same request could execute there too. Meeting that stronger
 *   cross-replica guarantee would require a shared external store (e.g. Redis
 *   with SET NX PX). The short TTL (default 60s) keeps this window bounded.
 * - Server restart naturally clears all entries.
 */

import { getSharedStore, checkMultiInstanceStoreWarning } from "./shared-store";

export interface CachedResponse {
  status: number;
  body: string; // JSON-stringified response body
  headers: Record<string, string>;
  createdAt: number; // Date.now() timestamp
}

/**
 * Maximum accepted Idempotency-Key length in bytes. Guards against memory
 * amplification: a megabyte-long header must not be stored verbatim in the map.
 */
export const MAX_KEY_LENGTH_BYTES = 256;

/** Default TTL: 60 seconds (configurable via IDEMPOTENCY_TTL_SECONDS env var). */
const DEFAULT_TTL_SECONDS = 60;

function ttlMs(): number {
  const env = process.env.IDEMPOTENCY_TTL_SECONDS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;
  }
  return DEFAULT_TTL_SECONDS * 1000;
}

/**
 * Validate an Idempotency-Key before it is used to read or write the store.
 *
 * Rejects:
 * - empty / whitespace-only values (treated as "no key" by callers)
 * - keys longer than MAX_KEY_LENGTH_BYTES (memory amplification)
 * - control characters (log/header injection hygiene)
 */
export function isValidIdempotencyKey(key: string): boolean {
  if (!key || key.trim().length === 0) return false;
  if (new TextEncoder().encode(key).length > MAX_KEY_LENGTH_BYTES) return false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    // C0 control chars + DEL are rejected; everything else (incl. printable
    // unicode) is fine and still bounded by the byte-length cap above.
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const store = new Map<string, CachedResponse>();

/**
 * Hard cap on stored responses. The lazy every-100-sets cleanup only drops
 * entries whose TTL has already elapsed; a flood of distinct in-TTL keys
 * would therefore grow the map without bound. This cap closes that gap.
 */
function maxEntries(): number {
  const env = process.env.IDEMPOTENCY_MAX_ENTRIES;
  if (env) {
    const parsed = parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 10_000;
}

function enforceCap(): void {
  const cap = maxEntries();
  if (store.size <= cap) return;
  let removed = store.size - cap;
  for (const key of store.keys()) {
    store.delete(key);
    if (--removed <= 0) break;
  }
}

/**
 * Retrieve a cached response by idempotency key.
 * Returns `null` if the key is not found, invalid, or the entry has expired.
 */
export function idempotencyGet(key: string): CachedResponse | null {
  checkMultiInstanceStoreWarning();
  if (!isValidIdempotencyKey(key)) return null;

  const entry = store.get(key);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > ttlMs()) {
    store.delete(key);
    return null;
  }

  return entry;
}

/**
 * Retrieve a cached response by idempotency key asynchronously from the shared store.
 * If configured with Upstash Redis / Vercel KV, queries the distributed store.
 */
export async function idempotencyGetAsync(key: string): Promise<CachedResponse | null> {
  checkMultiInstanceStoreWarning();
  if (!isValidIdempotencyKey(key)) return null;

  const local = idempotencyGet(key);
  if (local) return local;

  const sharedStore = getSharedStore();

  try {
    const raw = await sharedStore.get(`idem:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedResponse;
    if (Date.now() - parsed.createdAt > ttlMs()) {
      await sharedStore.del(`idem:${key}`).catch(() => null);
      return null;
    }
    store.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Store a response under an idempotency key with the current timestamp.
 * Invalid keys (empty, oversized, control chars) are silently ignored.
 */
export function idempotencySet(key: string, response: CachedResponse): void {
  if (!isValidIdempotencyKey(key)) return;

  store.set(key, response);

  const sharedStore = getSharedStore();
  const ttlSec = Math.ceil(ttlMs() / 1000);
  sharedStore.set(`idem:${key}`, JSON.stringify(response), ttlSec).catch(() => null);

  // Lazy cleanup: purge all expired entries every 100 new keys to avoid
  // unbounded growth. Skip on the very first set (size 0 would also match).
  if (store.size >= 100 && store.size % 100 === 0) {
    idempotencyCleanup();
  }
  enforceCap();
}

/**
 * Store a response under an idempotency key with the current timestamp asynchronously.
 */
export async function idempotencySetAsync(
  key: string,
  response: CachedResponse,
): Promise<void> {
  if (!isValidIdempotencyKey(key)) return;

  store.set(key, response);

  const sharedStore = getSharedStore();
  const ttlSec = Math.ceil(ttlMs() / 1000);
  await sharedStore.set(`idem:${key}`, JSON.stringify(response), ttlSec).catch(() => null);

  if (store.size >= 100 && store.size % 100 === 0) {
    idempotencyCleanup();
  }
}

/**
 * Remove all expired entries from the store.
 * Useful for testing and periodic maintenance.
 */
export function idempotencyCleanup(): void {
  const now = Date.now();
  const ttl = ttlMs();
  for (const [key, entry] of store) {
    if (now - entry.createdAt > ttl) {
      store.delete(key);
    }
  }
  // Also release stale in-flight slots (crashed or over-TTL leaders) so a
  // dead request can never block retries forever.
  pruneStaleInFlight(now, ttl);
}

/**
 * Clear the entire store. Only exposed for testing.
 */
export function idempotencyClear(): void {
  store.clear();
  inFlight.clear();
  getSharedStore().clear?.();
}

/**
 * Return the number of entries in the store. Only exposed for testing.
 */
export function idempotencySize(): number {
  return store.size;
}

// ---------------------------------------------------------------------------
// In-flight sentinel (single-flight de-duplication)
// ---------------------------------------------------------------------------

interface InFlightEntry {
  startedAt: number;
  promise: Promise<CachedResponse>;
  resolve: (response: CachedResponse) => void;
  reject: (error: unknown) => void;
}

const inFlight = new Map<string, InFlightEntry>();

/**
 * Release any in-flight slot that has outlived the TTL (a leader that
 * crashed — or ran longer than the TTL) so it can never block retries forever.
 */
function pruneStaleInFlight(now: number, ttl: number): void {
  for (const [key, entry] of inFlight) {
    if (now - entry.startedAt > ttl) {
      entry.reject(new Error("idempotency in-flight slot expired"));
      inFlight.delete(key);
    }
  }
}

/**
 * Begin — or join — an in-flight slot for `key`.
 *
 * - Returns `null` when the caller should proceed as the leader: no other
 *   request with this key is currently executing. The leader MUST call
 *   `idempotencyInFlightSettle` (or `idempotencyInFlightFail`) once it has a
 *   result so waiting duplicates can be released.
 * - Returns a Promise when a request with the same key is already executing.
 *   The caller should await that promise and replay the produced response
 *   instead of re-executing the request.
 *
 * Stale slots (a leader that crashed without settling) are pruned after the
 * TTL so a dead request can never block retries forever.
 */
export function idempotencyInFlightBegin(
  key: string,
): Promise<CachedResponse> | null {
  if (!isValidIdempotencyKey(key)) return null;

  const now = Date.now();
  const ttl = ttlMs();

  // Prune stale slots: a leader that crashed — or one that simply ran longer
  // than the TTL — must not block retries forever. This is a deliberate
  // liveness-vs-deduplication tradeoff: a slow-but-live leader past TTL can be
  // superseded, allowing a late duplicate to execute concurrently.
  pruneStaleInFlight(now, ttl);

  const existing = inFlight.get(key);
  if (existing) return existing.promise;

  let resolve!: (response: CachedResponse) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<CachedResponse>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Mark the promise as handled even if nobody awaits it (a slot that is
  // pruned or failed with no waiting duplicate must not crash the process
  // with an unhandled rejection).
  promise.catch(() => {});

  inFlight.set(key, { startedAt: now, promise, resolve, reject });
  return null;
}

/**
 * Resolve the in-flight slot for `key` with the produced response.
 * Any duplicate requests that joined the slot will replay this response.
 */
export function idempotencyInFlightSettle(
  key: string,
  response: CachedResponse,
): void {
  const entry = inFlight.get(key);
  if (!entry) return;
  inFlight.delete(key);
  entry.resolve(response);
}

/**
 * Reject the in-flight slot for `key` when the leader failed before producing
 * a response. Waiting duplicates will fall back to processing their own request.
 */
export function idempotencyInFlightFail(key: string, error: unknown): void {
  const entry = inFlight.get(key);
  if (!entry) return;
  inFlight.delete(key);
  entry.reject(error);
}

/**
 * Return the number of in-flight slots. Only exposed for testing.
 */
export function idempotencyInFlightSize(): number {
  return inFlight.size;
}
