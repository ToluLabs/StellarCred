/**
 * credential-import-bounds.ts - Enforces strict resource limits and input
 * validation for credential and backup imports (#977).
 *
 * Security objective:
 * Prevent denial-of-service, memory exhaustion, and corrupted storage states
 * caused by malformed or adversarial import payloads before running expensive
 * cryptographic or storage operations.
 *
 * Integrity objective (bundle safety):
 * Exported bundles carry a SHA-256 checksum over their canonical payload.
 * Imports verify the checksum before any record is applied, so tampered,
 * truncated, or otherwise corrupted bundles are rejected with an actionable
 * error instead of being partially restored.
 */

import { createHash, timingSafeEqual } from "crypto";
import type { Credential } from "./credential";

export const MAX_IMPORT_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
export const MAX_IMPORT_NESTING_DEPTH = 5;
export const MAX_IMPORT_RECORD_COUNT = 50;
export const MAX_IMPORT_STRING_LENGTH = 4096;

export const BUNDLE_FORMAT_VERSION = 1;
export const BUNDLE_CHECKSUM_ALGORITHM = "sha256";

/**
 * Integrity envelope attached to every exported credential bundle.
 * `checksum` is the hex SHA-256 of the canonical JSON serialization of `records`.
 */
export interface BundleIntegrity {
  version: number;
  algorithm: typeof BUNDLE_CHECKSUM_ALGORITHM;
  checksum: string;
  recordCount: number;
  exportedAt: number;
}

export interface CredentialBundle {
  integrity: BundleIntegrity;
  records: unknown[];
}

/**
 * Serializes a value to canonical JSON: object keys are sorted recursively so
 * that the same logical content always yields the same byte sequence.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

/** Computes the hex SHA-256 checksum of a records array in canonical form. */
export function computeBundleChecksum(records: unknown[]): string {
  return createHash(BUNDLE_CHECKSUM_ALGORITHM)
    .update(canonicalJson(records), "utf8")
    .digest("hex");
}

/**
 * Wraps credential records in an integrity-protected bundle suitable for export.
 */
export function createCredentialBundle(
  records: unknown[],
  exportedAt: number = Date.now(),
): CredentialBundle {
  if (records.length > MAX_IMPORT_RECORD_COUNT) {
    throw new Error(
      `Cannot export ${records.length} records: exceeds maximum of ${MAX_IMPORT_RECORD_COUNT} per bundle`,
    );
  }
  return {
    integrity: {
      version: BUNDLE_FORMAT_VERSION,
      algorithm: BUNDLE_CHECKSUM_ALGORITHM,
      checksum: computeBundleChecksum(records),
      recordCount: records.length,
      exportedAt,
    },
    records,
  };
}

/**
 * Verifies a parsed bundle's integrity envelope against its records.
 * Throws descriptive errors for each failure mode so users can act on them.
 */
export function verifyCredentialBundle(bundle: unknown): unknown[] {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("Bundle is not a valid object: expected an integrity envelope with records");
  }

  const { integrity, records } = bundle as Partial<CredentialBundle>;

  if (!Array.isArray(records)) {
    throw new Error("Bundle is missing its records array");
  }
  if (records.length > MAX_IMPORT_RECORD_COUNT) {
    throw new Error(
      `Import record count (${records.length}) exceeds maximum limit of ${MAX_IMPORT_RECORD_COUNT}`,
    );
  }

  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) {
    throw new Error(
      "Bundle is missing integrity metadata: it was not produced by a supported export or was edited manually",
    );
  }

  if (integrity.version !== BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported bundle version ${String(integrity.version)}: this app supports version ${BUNDLE_FORMAT_VERSION}`,
    );
  }
  if (integrity.algorithm !== BUNDLE_CHECKSUM_ALGORITHM) {
    throw new Error(`Unsupported checksum algorithm "${String(integrity.algorithm)}"`);
  }
  if (typeof integrity.checksum !== "string" || !/^[0-9a-f]{64}$/.test(integrity.checksum)) {
    throw new Error("Bundle integrity checksum is malformed");
  }
  if (integrity.recordCount !== records.length) {
    throw new Error(
      `Bundle record count mismatch: metadata says ${String(integrity.recordCount)} but ${records.length} were found. The file may be truncated or edited`,
    );
  }

  const actual = Buffer.from(computeBundleChecksum(records), "hex");
  const expected = Buffer.from(integrity.checksum, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(
      "Bundle integrity check failed: content does not match its checksum. The file appears corrupted or was tampered with. Re-export from the source environment and try again",
    );
  }

  return records;
}

/**
 * Validates that raw JSON text does not exceed the allowed nesting depth.
 * Counts bracket and brace nesting levels while ignoring escaped string contents.
 */
export function validateJsonNestingDepth(
  raw: string,
  maxDepth: number = MAX_IMPORT_NESTING_DEPTH,
): void {
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth++;
      if (depth > maxDepth) {
        throw new Error(`Import payload exceeds maximum nesting depth of ${maxDepth}`);
      }
    } else if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
    }
  }
}

/**
 * Recursively verifies that all keys and string values in an object do not
 * exceed MAX_IMPORT_STRING_LENGTH.
 */
export function validateStringLengths(
  node: unknown,
  maxLength: number = MAX_IMPORT_STRING_LENGTH,
  currentDepth: number = 0,
): void {
  if (currentDepth > MAX_IMPORT_NESTING_DEPTH) {
    throw new Error(`Import payload exceeds maximum nesting depth of ${MAX_IMPORT_NESTING_DEPTH}`);
  }

  if (typeof node === "string") {
    if (node.length > maxLength) {
      throw new Error(`Import string property exceeds maximum length of ${maxLength} characters`);
    }
  } else if (Array.isArray(node)) {
    for (const item of node) {
      validateStringLengths(item, maxLength, currentDepth + 1);
    }
  } else if (node && typeof node === "object") {
    for (const [key, val] of Object.entries(node)) {
      if (key.length > maxLength) {
        throw new Error(`Import property name exceeds maximum length of ${maxLength} characters`);
      }
      validateStringLengths(val, maxLength, currentDepth + 1);
    }
  }
}

/**
 * Validates an import payload string against file size, nesting depth,
 * JSON validity, record count, string length bounds, and bundle integrity.
 *
 * Bundles (objects with an `integrity` envelope) are checksum-verified and
 * their records are returned. Legacy bare arrays are still accepted under the
 * same bounds, since they predate integrity metadata.
 */
export function validateImportPayload(raw: string): unknown {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("Import payload must be a non-empty string");
  }

  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength > MAX_IMPORT_FILE_SIZE_BYTES) {
    throw new Error(
      `Import payload size (${byteLength} bytes) exceeds maximum limit of ${MAX_IMPORT_FILE_SIZE_BYTES} bytes`,
    );
  }

  validateJsonNestingDepth(raw, MAX_IMPORT_NESTING_DEPTH);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed JSON in import payload: ${(err as Error).message}. The file may be truncated or corrupted`,
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Import payload must be a JSON object or array");
  }

  validateStringLengths(parsed, MAX_IMPORT_STRING_LENGTH, 0);

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error("Import payload array must not be empty");
    }
    if (parsed.length > MAX_IMPORT_RECORD_COUNT) {
      throw new Error(
        `Import record count (${parsed.length}) exceeds maximum limit of ${MAX_IMPORT_RECORD_COUNT}`,
      );
    }
    return parsed;
  }

  if ("integrity" in parsed) {
    const records = verifyCredentialBundle(parsed);
    if (records.length === 0) {
      throw new Error("Bundle contains no records to import");
    }
    return records;
  }

  throw new Error(
    "Import payload has no integrity metadata. Re-export the bundle with a supported version to enable verification",
  );
}

/**
 * Deterministically deduplicates credentials based on commitment hash.
 * If duplicate commitments are present, keeps the latest issuedAt credential.
 */
export function deduplicateCredentials(credentials: Credential[]): Credential[] {
  const seen = new Map<string, Credential>();

  for (const cred of credentials) {
    const key = cred.commitment || `${cred.type}:${cred.issuerId}:${cred.issuedAt}`;
    const existing = seen.get(key);
    if (!existing || (cred.issuedAt ?? 0) >= (existing.issuedAt ?? 0)) {
      seen.set(key, cred);
    }
  }

  return Array.from(seen.values());
}
