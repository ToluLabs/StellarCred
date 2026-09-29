/**
 * Hash-chained, PII-free issuance audit log.
 *
 * Every credential issuance appends one entry recording the signed commitment
 * (a Poseidon2 hash — never the underlying attribute), the issuer id, a unix
 * timestamp, and the request id. Each entry's hash covers the previous entry's
 * hash, so the chain is tamper-evident: altering any historical entry — or its
 * position — breaks every subsequent hash, which a verifier can detect.
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

/** Length of a SHA-256 digest in bytes. */
export const HASH_BYTES = 32;
/** Length of a SHA-256 digest in lowercase-hex characters. */
export const HASH_HEX_LENGTH = HASH_BYTES * 2;

/**
 * `prevHash` of the first (genesis) entry — 64 zero hex characters.
 */
export const GENESIS_PREV_HASH = "0".repeat(HASH_HEX_LENGTH);

export interface AuditLogFields {
  timestamp: number;
  requestId: string;
  issuer: string;
  commitment: string;
}

export interface AuditLogEntry extends AuditLogFields {
  index: number;
  prevHash: string;
  hash: string;
}

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

export function hashAuditEntry(
  fields: AuditLogFields,
  prevHash: string,
): string {
  return createHash("sha256")
    .update(canonicalEntryFields(fields, prevHash))
    .digest("hex");
}

export function expectedPrevHash(chain: AuditLogEntry[]): string {
  return chain.length === 0 ? GENESIS_PREV_HASH : chain[chain.length - 1].hash;
}

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
  errors: string[];
}

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
// Pluggable Audit Sink Architecture (Issue #549)
// ---------------------------------------------------------------------------

export interface AuditSink {
  read(): Promise<AuditLogEntry[]>;
  write(entries: AuditLogEntry[]): Promise<void>;
  validateStartup(): Promise<void>;
}

export class FileAuditSink implements AuditSink {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      process.env.AUDIT_LOG_PATH ??
      path.join(process.cwd(), ".data", "audit-log.jsonl");
  }

  async read(): Promise<AuditLogEntry[]> {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      return parseAuditLogLines(text);
    } catch {
      return [];
    }
  }

  async write(entries: AuditLogEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, auditLogToJSONLines(entries), "utf8");
  }

  async validateStartup(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      const testFile = path.join(dir, `.probe-${Date.now()}`);
      await fs.writeFile(testFile, "", "utf8");
      await fs.unlink(testFile);
    } catch (err) {
      throw new Error(
        `Audit sink misconfigured or read-only: failed to write to audit log path "${this.filePath}". ` +
          `Serverless environments require a persistent, writable audit sink or mounted volume. Root cause: ${err}`,
      );
    }
  }
}

function getActiveSink(): AuditSink {
  return new FileAuditSink();
}

const ALLOWED_ENTRY_KEYS = [
  "index",
  "timestamp",
  "requestId",
  "issuer",
  "commitment",
  "prevHash",
  "hash",
];

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
let activeSink: AuditSink = getActiveSink();

export function auditLogFilePath(): string {
  return (
    process.env.AUDIT_LOG_PATH ??
    path.join(process.cwd(), ".data", "audit-log.jsonl")
  );
}

export async function auditLogBootstrap(filePath?: string): Promise<void> {
  if (filePath) {
    activeSink = new FileAuditSink(filePath);
  }
  if (bootstrapPromise) return bootstrapPromise;
  
  bootstrapPromise = (async () => {
    await activeSink.validateStartup();
    try {
      chain = await activeSink.read();
    } catch {
      chain = [];
    }
  })();
  return bootstrapPromise;
}

export function auditLogAppend(fields: AuditLogFields): AuditLogEntry {
  return appendAuditEntry(chain, fields);
}

export function auditLogEntries(): AuditLogEntry[] {
  return chain.slice();
}

export function auditLogVerify(): AuditVerifyResult {
  return verifyAuditChain(chain);
}

export function auditLogSeed(entries: AuditLogEntry[]): void {
  chain = entries.slice();
}

export function auditLogClear(): void {
  chain = [];
  bootstrapPromise = null;
}

export function auditLogSize(): number {
  return chain.length;
}

export function auditLogToJSONLines(entries: AuditLogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

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

export async function readAuditLogFile(
  filePath?: string,
): Promise<AuditLogEntry[]> {
  const sink = filePath ? new FileAuditSink(filePath) : activeSink;
  return sink.read();
}

export async function auditLogPersist(filePath?: string): Promise<void> {
  const sink = filePath ? new FileAuditSink(filePath) : activeSink;
  await sink.write(chain);
}
