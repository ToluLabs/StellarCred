/**
 * credential-import-bounds.ts - Enforces strict resource limits and input
 * validation for credential and backup imports (#977).
 *
 * Security objective:
 * Prevent denial-of-service, memory exhaustion, and corrupted storage states
 * caused by malformed or adversarial import payloads before running expensive
 * cryptographic or storage operations.
 */

import type { Credential } from "./credential";

export const MAX_IMPORT_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
export const MAX_IMPORT_NESTING_DEPTH = 5;
export const MAX_IMPORT_RECORD_COUNT = 50;
export const MAX_IMPORT_STRING_LENGTH = 4096;

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
 * JSON validity, record count, and string length bounds.
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
    throw new Error(`Malformed JSON in import payload: ${(err as Error).message}`);
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
  }

  return parsed;
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
