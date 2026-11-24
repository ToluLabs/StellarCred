import { parseCredential, type Credential } from "./credential";
import {
  MAX_IMPORT_FILE_SIZE_BYTES,
  MAX_IMPORT_NESTING_DEPTH,
  MAX_IMPORT_STRING_LENGTH,
  validateImportPayload,
  validateJsonNestingDepth,
  validateStringLengths,
} from "./credential-import-bounds";

/**
 * Bare arrays and integrity bundles go through the full import checks. Since
 * #940, validateImportPayload rejects any other object for lacking bundle
 * integrity metadata, but a single plaintext credential (and an encrypted
 * backup envelope, rejected below with its own message) is a whole document
 * here, so it keeps the same size, depth and string bounds without that rule.
 */
function readBoundedDocument(json: string): unknown {
  if (typeof json !== "string") return validateImportPayload(json);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > MAX_IMPORT_FILE_SIZE_BYTES) {
    throw new Error(
      `Import payload size (${byteLength} bytes) exceeds maximum limit of ${MAX_IMPORT_FILE_SIZE_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return validateImportPayload(json); // throws its actionable parse error
  }
  if (Array.isArray(value) || !value || typeof value !== "object" || "integrity" in value) {
    return validateImportPayload(json);
  }
  validateJsonNestingDepth(json, MAX_IMPORT_NESTING_DEPTH);
  validateStringLengths(value, MAX_IMPORT_STRING_LENGTH, 0);
  return value;
}

export function parseCredentialDocument(json: string): Credential | Credential[] {
  const value = readBoundedDocument(json);
  if (Array.isArray(value)) {
    return value.map((credential) => parseCredential(JSON.stringify(credential)));
  }
  if (value && typeof value === "object" && "version" in value) {
    throw new Error(
      "Encrypted backup envelopes are not plaintext credential exports. Import them in the app with the backup passphrase.",
    );
  }
  return parseCredential(json);
}

export function serializeCredentialDocument(value: Credential | Credential[]): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
