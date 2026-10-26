import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getSharedStore, checkMultiInstanceStoreWarning } from "./shared-store";

/**
 * Idempotency records for issuance endpoints.
 *
 * Privacy and retention:
 * - Single issuance is represented only by a SHA-256 response hash. Successful
 *   batch responses are AES-GCM encrypted before caching so credential material
 *   is not readable in the process map or shared-store records.
 * - Persona redirects retain only the inquiry ID and provider URL needed to
 *   resume that redirect; no request attributes are retained.
 * - Records expire after IDEMPOTENCY_TTL_SECONDS (60 seconds by default). This
 *   is the maximum persistence window in either the in-process Map or a shared
 *   store such as Redis. Keep the TTL short when configuring a shared store.
 *   During rollout, purge existing `idem:*` shared-store entries from versions
 *   that stored full responses; a legacy record is scrubbed when it is read.
 * - Batch replay encryption requires IDEMPOTENCY_REPLAY_ENCRYPTION_KEY. Keep
 *   it secret, stable across replicas, and separate from the shared-store key.
 *   Rotate it only after cached records expire or retries will return 503.
 *
 * Scope / known limitation:
 * - The in-flight sentinel de-duplicates only within one server instance.
 *   A shared store prevents re-execution after a completed request, but an
 *   atomic distributed lock is still needed to deduplicate simultaneous
 *   requests on separate replicas.
 * - Server restart clears local records.
 */

export interface CompletedIdempotencyRecord {
  version: 1;
  kind: "completed";
  responseHash: string;
  createdAt: number;
}

export interface EncryptedResponseIdempotencyRecord {
  version: 1;
  kind: "encrypted_response";
  status: number;
  nonce: string;
  authTag: string;
  ciphertext: string;
  createdAt: number;
}

export interface PersonaPendingIdempotencyRecord {
  version: 1;
  kind: "persona_pending";
  inquiryId: string;
  personaUrl: string;
  createdAt: number;
}

export type IdempotencyRecord =
  | CompletedIdempotencyRecord
  | EncryptedResponseIdempotencyRecord
  | PersonaPendingIdempotencyRecord;

function replayEncryptionKey(): Buffer {
  const value = process.env.IDEMPOTENCY_REPLAY_ENCRYPTION_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("IDEMPOTENCY_REPLAY_ENCRYPTION_KEY must be 64 hexadecimal characters");
  }
  return Buffer.from(value, "hex");
}

export function hasReplayEncryptionKey(): boolean {
  try {
    replayEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypts a successful batch response before it enters the idempotency cache. */
export function encryptedResponseIdempotencyRecord(
  status: number,
  body: string,
): EncryptedResponseIdempotencyRecord {
  const createdAt = Date.now();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", replayEncryptionKey(), nonce);
  cipher.setAAD(Buffer.from(`${status}\n${createdAt}`));
  const ciphertext = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  return {
    version: 1,
    kind: "encrypted_response",
    status,
    nonce: nonce.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    createdAt,
  };
}

/** Decrypts a successful batch response after authenticating its cache record. */
export function decryptEncryptedResponseIdempotencyRecord(
  record: EncryptedResponseIdempotencyRecord,
): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    replayEncryptionKey(),
    Buffer.from(record.nonce, "base64url"),
  );
  decipher.setAAD(Buffer.from(`${record.status}\n${record.createdAt}`));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
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

function remainingTtlSeconds(createdAt: number): number {
  const remaining = ttlMs() - (Date.now() - createdAt);
  return Math.max(1, Math.ceil(remaining / 1000));
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
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function completedIdempotencyRecord(
  status: number,
  body: string,
): CompletedIdempotencyRecord {
  return {
    version: 1,
    kind: "completed",
    responseHash: createHash("sha256")
      .update(String(status))
      .update("\n")
      .update(body)
      .digest("hex"),
    createdAt: Date.now(),
  };
}

export function personaPendingIdempotencyRecord(
  inquiryId: string,
  personaUrl: string,
): PersonaPendingIdempotencyRecord {
  return {
    version: 1,
    kind: "persona_pending",
    inquiryId,
    personaUrl,
    createdAt: Date.now(),
  };
}

const store = new Map<string, IdempotencyRecord>();

/**
 * Hard cap on stored records. The lazy every-100-sets cleanup only drops
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

function isExpired(record: IdempotencyRecord): boolean {
  return Date.now() - record.createdAt > ttlMs();
}

function parseStoredRecord(raw: string): {
  record: IdempotencyRecord;
  legacy: boolean;
} | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const value = parsed as Record<string, unknown>;
  if (typeof value.createdAt !== "number") return null;

  if (
    value.version === 1 &&
    value.kind === "completed" &&
    typeof value.responseHash === "string"
  ) {
    return {
      record: {
        version: 1,
        kind: "completed",
        responseHash: value.responseHash,
        createdAt: value.createdAt,
      },
      legacy: false,
    };
  }

  if (
    value.version === 1 &&
    value.kind === "encrypted_response" &&
    typeof value.status === "number" &&
    value.status >= 200 && value.status < 300 &&
    typeof value.nonce === "string" &&
    typeof value.authTag === "string" &&
    typeof value.ciphertext === "string"
  ) {
    return {
      record: {
        version: 1,
        kind: "encrypted_response",
        status: value.status,
        nonce: value.nonce,
        authTag: value.authTag,
        ciphertext: value.ciphertext,
        createdAt: value.createdAt,
      },
      legacy: false,
    };
  }

  if (
    value.version === 1 &&
    value.kind === "persona_pending" &&
    typeof value.inquiryId === "string" &&
    typeof value.personaUrl === "string"
  ) {
    return {
      record: {
        version: 1,
        kind: "persona_pending",
        inquiryId: value.inquiryId,
        personaUrl: value.personaUrl,
        createdAt: value.createdAt,
      },
      legacy: false,
    };
  }

  if (typeof value.body === "string") {
    const status = typeof value.status === "number" ? value.status : 200;
    return {
      record: {
        ...completedIdempotencyRecord(status, value.body),
        createdAt: value.createdAt,
      },
      legacy: true,
    };
  }

  return null;
}

function persistLocal(key: string, record: IdempotencyRecord): void {
  store.set(key, record);

  if (store.size >= 100 && store.size % 100 === 0) {
    idempotencyCleanup();
  }
  enforceCap();
}

async function persistShared(
  key: string,
  record: IdempotencyRecord,
): Promise<void> {
  await getSharedStore()
    .set(`idem:${key}`, JSON.stringify(record), remainingTtlSeconds(record.createdAt))
    .catch(() => null);
}

/**
 * Retrieve an idempotency record by key from this process.
 * Returns `null` if the key is not found, invalid, or expired.
 */
export function idempotencyGet(key: string): IdempotencyRecord | null {
  checkMultiInstanceStoreWarning();
  if (!isValidIdempotencyKey(key)) return null;

  const entry = store.get(key);
  if (!entry) return null;

  if (isExpired(entry)) {
    store.delete(key);
    return null;
  }

  return entry;
}

/**
 * Retrieve an idempotency record from the configured shared store.
 * Legacy full-response records are immediately overwritten with a redacted
 * completion marker and are never replayed.
 */
export async function idempotencyGetAsync(
  key: string,
): Promise<IdempotencyRecord | null> {
  checkMultiInstanceStoreWarning();
  if (!isValidIdempotencyKey(key)) return null;

  const local = idempotencyGet(key);
  if (local) return local;

  try {
    const raw = await getSharedStore().get(`idem:${key}`);
    if (!raw) return null;

    const parsed = parseStoredRecord(raw);
    if (!parsed) return null;
    if (isExpired(parsed.record)) {
      await getSharedStore().del(`idem:${key}`).catch(() => null);
      return null;
    }

    persistLocal(key, parsed.record);
    if (parsed.legacy) await persistShared(key, parsed.record);
    return parsed.record;
  } catch {
    return null;
  }
}

/**
 * Store an idempotency record under a key. Batch response records contain only
 * authenticated ciphertext; invalid keys are ignored.
 */
export function idempotencySet(key: string, record: IdempotencyRecord): void {
  if (!isValidIdempotencyKey(key)) return;

  persistLocal(key, record);
  void persistShared(key, record);
}

/**
 * Store an idempotency record in the configured shared store.
 */
export async function idempotencySetAsync(
  key: string,
  record: IdempotencyRecord,
): Promise<void> {
  if (!isValidIdempotencyKey(key)) return;

  persistLocal(key, record);
  await persistShared(key, record);
}

/**
 * Remove all expired entries from the local store.
 * Useful for testing and periodic maintenance.
 */
export function idempotencyCleanup(): void {
  for (const [key, entry] of store) {
    if (isExpired(entry)) {
      store.delete(key);
    }
  }
  pruneStaleInFlight(Date.now(), ttlMs());
}

/**
 * Clear the entire local store. Only exposed for testing.
 */
export function idempotencyClear(): void {
  store.clear();
  inFlight.clear();
  getSharedStore().clear?.();
}

/**
 * Return the number of local entries. Only exposed for testing.
 */
export function idempotencySize(): number {
  return store.size;
}

// ---------------------------------------------------------------------------
// In-flight sentinel (single-flight de-duplication)
// ---------------------------------------------------------------------------

interface InFlightEntry {
  startedAt: number;
  promise: Promise<IdempotencyRecord>;
  resolve: (record: IdempotencyRecord) => void;
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
 * The slot resolves with an idempotency record. Batch response bodies are
 * encrypted before being placed here; single-issuance records remain hashes.
 */
export function idempotencyInFlightBegin(
  key: string,
): Promise<IdempotencyRecord> | null {
  if (!isValidIdempotencyKey(key)) return null;

  const now = Date.now();
  const ttl = ttlMs();
  pruneStaleInFlight(now, ttl);

  const existing = inFlight.get(key);
  if (existing) return existing.promise;

  let resolve!: (record: IdempotencyRecord) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<IdempotencyRecord>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});

  inFlight.set(key, { startedAt: now, promise, resolve, reject });
  return null;
}

/**
 * Resolve the in-flight slot for `key` with a minimal record.
 */
export function idempotencyInFlightSettle(
  key: string,
  record: IdempotencyRecord,
): void {
  const entry = inFlight.get(key);
  if (!entry) return;
  inFlight.delete(key);
  entry.resolve(record);
}

/**
 * Reject the in-flight slot for `key` when the leader failed before producing
 * a record. Waiting duplicates can process their own request.
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
