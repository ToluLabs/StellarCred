/**
 * Hash-chained, PII-free issuance audit log.
 *
 * Every credential issuance appends one entry recording the signed commitment
 * (a Poseidon2 hash — never the underlying attribute), the issuer id, a unix
 * timestamp, and the request id. Each entry's hash covers the previous entry's
 * hash, so the chain is tamper-evident: altering any historical entry — or its
 * position — breaks every subsequent hash, which a verifier can detect.
 *
 * PII policy — entries intentionally contain ONLY:
 *   - commitment  (hash of [value, salt]; reveals nothing about the holder)
 *   - issuer      (the issuer's registered id / address)
 *   - timestamp   (unix seconds)
 *   - requestId   (opaque correlation id)
 *
 * first_name / last_name / id_number / wallet address / attribute values are
 * never written. The line parser additionally rejects any unknown key, so a
 * tampered file that tries to smuggle identity fields in is refused by the
 * verifier instead of silently accepted.
 *
 * ## Persistence
 *
 * The in-memory store follows the same in-process pattern as lib/rate-limit.ts
 * and lib/idempotency.ts. `auditLogBootstrap()` loads an existing log file on
 * startup (so the chain continues across restarts instead of restarting at
 * index 0), and `auditLogPersist()` rewrites the whole file after each append.
 * A multi-replica deployment would need the chain stored in shared storage —
 * see the note in lib/idempotency.ts; this module is correct for a single
 * long-lived instance.
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

/** Length of a SHA-256 digest in bytes. */
export const HASH_BYTES = 32;
/** Length of a SHA-256 digest in lowercase-hex characters. */
export const HASH_HEX_LENGTH = HASH_BYTES * 2;

/**
 * `prevHash` of the first (genesis) entry — 64 zero hex characters. There is
 * no previous entry to point at, so the chain roots itself in this constant.
 */
export const GENESIS_PREV_HASH = "0".repeat(HASH_HEX_LENGTH);

/**
 * The non-identity fields an issuance contributes to the audit log. Only these
 * keys are ever serialized; the type intentionally has no holder / attribute /
 * name fields, so identity data cannot be appended by construction.
 */
export interface AuditLogFields {
  /** Unix seconds at which the commitment was signed. */
  timestamp: number;
  /** Opaque request correlation id (see lib/logger.ts resolveRequestId). */
  requestId: string;
  /** The issuer's registered id / address. */
  issuer: string;
  /** The signed Poseidon2 commitment (hex). */
  commitment: string;
}

/**
 * One fully-formed audit log entry: the PII-free fields plus the chaining
 * metadata (`index`, `prevHash`) and this entry's own digest (`hash`).
 */
export interface AuditLogEntry extends AuditLogFields {
  /** Position in the chain, starting at 0 for the genesis entry. */
  index: number;
  /** Hash of the previous entry in the chain (GENESIS_PREV_HASH for entry 0). */
  prevHash: string;
  /** SHA-256 over this entry's fields plus prevHash. */
  hash: string;
}

/**
 * Canonically serialize the fields that make up an entry's digest.
 * JSON.stringify of a fixed-order array is unambiguous (no separator
 * collision) and deterministic across platforms.
 */
export function canonicalEntryFields(
  fields: AuditLogFields,
  prevHash: string,
): string {
  return JSON.stringify([
    fields.timestamp,
    fields.requestId,
    fields.issuer,
    fields.commitment,
    prevHash,
  ]);
}

/**
 * Compute the SHA-256 digest for an entry given its PII-free fields and the
 * hash it chains from. `index` is intentionally NOT part of the digest — it is
 * derived from position, so the verifier treats a re-ordered entry as broken
 * chaining rather than trusting a stored index.
 */
export function hashAuditEntry(
  fields: AuditLogFields,
  prevHash: string,
): string {
  return createHash("sha256")
    .update(canonicalEntryFields(fields, prevHash))
    .digest("hex");
}

/** Expected `prevHash` for the next entry given the current head of `chain`. */
export function expectedPrevHash(chain: AuditLogEntry[]): string {
  return chain.length === 0 ? GENESIS_PREV_HASH : chain[chain.length - 1].hash;
}

/**
 * Append a PII-free issuance event to `chain`, deriving index, prevHash, and
 * hash. The caller-supplied chain is mutated and the new entry returned so
 * pure use is possible (e.g. the verify CLI over file-loaded entries).
 */
export function appendAuditEntry(
  chain: AuditLogEntry[],
  fields: AuditLogFields,
): AuditLogEntry {
  const prevHash = expectedPrevHash(chain);
  const entry: AuditLogEntry = {
    ...fields,
    index: chain.length,
    prevHash,
    hash: hashAuditEntry(fields, prevHash),
  };
  chain.push(entry);
  return entry;
}

export interface AuditVerifyResult {
  valid: boolean;
  /** Human-readable problems, in chain order. Empty when `valid` is true. */
  errors: string[];
}

/**
 * Verify the integrity of a hash-chained log.
 *
 * Detects:
 *   - a corrupted entry hash (its recomputed digest differs),
 *   - a broken link (an entry whose prevHash does not match the previous
 *     entry's hash),
 *   - a wrong index (an entry inserted, deleted, or re-ordered),
 *   - a chain that does not root at the genesis prev-hash.
 */
export function verifyAuditChain(chain: AuditLogEntry[]): AuditVerifyResult {
  const errors: string[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (entry.index !== i) {
      errors.push(
        `entry ${i}: expected index ${i}, found ${entry.index} (entry inserted, deleted, or re-ordered)`,
      );
    }
    if (entry.prevHash !== prevHash) {
      errors.push(
        `entry ${i}: prevHash ${entry.prevHash} does not match previous entry hash ${prevHash}`,
      );
    }
    const expected = hashAuditEntry(
      {
        timestamp: entry.timestamp,
        requestId: entry.requestId,
        issuer: entry.issuer,
        commitment: entry.commitment,
      },
      entry.prevHash,
    );
    if (entry.hash !== expected) {
      errors.push(
        `entry ${i}: stored hash ${entry.hash} does not match recomputed hash ${expected}`,
      );
    }
    prevHash = entry.hash;
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// In-memory store (single-instance pattern — see module docs)
// ---------------------------------------------------------------------------

const ALLOWED_ENTRY_KEYS = [
  "index",
  "timestamp",
  "requestId",
  "issuer",
  "commitment",
  "prevHash",
  "hash",
];

/**
 * Reject any serialized entry carrying a key outside the PII-free allowlist
 * (e.g. a tampered `first_name` / `last_name` / `id_number` field smuggled
 * into the file). Throws on the first disallowed key.
 */
export function assertPiiFreeEntry(entry: Record<string, unknown>): void {
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_ENTRY_KEYS.includes(key)) {
      throw new Error(
        `audit log entry contains disallowed field "${key}" (identity data is never written to the audit log)`,
      );
    }
  }
}

let chain: AuditLogEntry[] = [];
let bootstrapPromise: Promise<void> | null = null;

/**
 * Default audit log file location. `AUDIT_LOG_PATH` overrides it; otherwise
 * `.data/audit-log.jsonl` under the process working directory (the frontend
 * dir when run via `pnpm dev` / `next build`).
 */
export function auditLogFilePath(): string {
  return (
    process.env.AUDIT_LOG_PATH ??
    path.join(process.cwd(), ".data", "audit-log.jsonl")
  );
}

/**
 * Load an existing log file into the in-memory store so the chain continues
 * across restarts instead of restarting at index 0. Runs once per process;
 * a missing/unreadable file is treated as an empty chain.
 */
export async function auditLogBootstrap(filePath?: string): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    try {
      chain = await readAuditLogFile(filePath ?? auditLogFilePath());
    } catch {
      // No file yet (first boot) or unreadable — start a fresh chain.
      chain = [];
    }
  })();
  return bootstrapPromise;
}

/**
 * Append a PII-free issuance event to the in-memory chain. The chain must be
 * bootstrapped first (the /api/issue route does this before appending).
 */
export function auditLogAppend(fields: AuditLogFields): AuditLogEntry {
  return appendAuditEntry(chain, fields);
}

/** Snapshot of the current chain (defensive copy — callers may not mutate it). */
export function auditLogEntries(): AuditLogEntry[] {
  return chain.slice();
}

/** Verify the current in-memory chain. */
export function auditLogVerify(): AuditVerifyResult {
  return verifyAuditChain(chain);
}

/** Replace the in-memory chain wholesale (used by bootstrap and tests). */
export function auditLogSeed(entries: AuditLogEntry[]): void {
  chain = entries.slice();
}

/** Clear the in-memory chain. Only for tests. */
export function auditLogClear(): void {
  chain = [];
  bootstrapPromise = null;
}

/** Number of entries currently in the in-memory chain. Only for tests. */
export function auditLogSize(): number {
  return chain.length;
}

// ---------------------------------------------------------------------------
// File persistence (JSON-lines; one entry per line)
// ---------------------------------------------------------------------------

/**
 * Serialize entries as JSON-lines. Each entry is one line so the file is
 * append-oriented and stays parseable even if a write is interrupted.
 */
export function auditLogToJSONLines(entries: AuditLogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/**
 * Parse a JSON-lines log file body back into entries, rejecting any line that
 * (a) is not valid JSON, (b) carries a disallowed identity field, or (c) has
 * a missing/mistyped required field.
 */
export function parseAuditLogLines(text: string): AuditLogEntry[] {
  const entries: AuditLogEntry[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = 0; i < lines.length; i++) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i]);
    } catch {
      throw new Error(`audit log line ${i + 1}: invalid JSON`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`audit log line ${i + 1}: expected a JSON object`);
    }
    const record = raw as Record<string, unknown>;
    assertPiiFreeEntry(record);
    const entry: AuditLogEntry = {
      index: record.index as number,
      timestamp: record.timestamp as number,
      requestId: record.requestId as string,
      issuer: record.issuer as string,
      commitment: record.commitment as string,
      prevHash: record.prevHash as string,
      hash: record.hash as string,
    };
    if (
      typeof entry.index !== "number" ||
      typeof entry.timestamp !== "number" ||
      typeof entry.requestId !== "string" ||
      typeof entry.issuer !== "string" ||
      typeof entry.commitment !== "string" ||
      typeof entry.prevHash !== "string" ||
      typeof entry.hash !== "string"
    ) {
      throw new Error(`audit log line ${i + 1}: missing or mistyped field`);
    }
    entries.push(entry);
  }
  return entries;
}

/** Read and parse the log file at `filePath` (default: auditLogFilePath()). */
export async function readAuditLogFile(
  filePath?: string,
): Promise<AuditLogEntry[]> {
  const target = filePath ?? auditLogFilePath();
  const text = await fs.readFile(target, "utf8");
  return parseAuditLogLines(text);
}

/**
 * Persist the current in-memory chain to `filePath` (default:
 * auditLogFilePath()) as JSON-lines. Creates the parent directory as needed.
 */
export async function auditLogPersist(filePath?: string): Promise<void> {
  const target = filePath ?? auditLogFilePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, auditLogToJSONLines(chain), "utf8");
}
