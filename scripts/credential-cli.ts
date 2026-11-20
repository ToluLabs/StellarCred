#!/usr/bin/env node
/**
 * StellarCred - Offline Credential Export/Import CLI Helper (#811)
 *
 * Provides script-based, auditable, offline recovery, backup, migration,
 * and CI fixture management for credential data.
 *
 * Compatible with the StellarCred browser app:
 * - Plain JSON backup arrays (as exported by HolderPage / exportCredentials())
 * - Versioned envelope backups ({ version, exportedAt, generator, credentials })
 * - AES-256-GCM + PBKDF2 encrypted backup envelopes (v1, v2, v3)
 *
 * Usage:
 *   node --experimental-strip-types scripts/credential-cli.ts <command> [options]
 *
 * Commands:
 *   export     Export credentials to plain or encrypted JSON backup file
 *   import     Import credentials from backup file into app-compatible JSON
 *   validate   Verify format and cryptographic structural integrity
 *   inspect    Display credential details offline with sensitive fields redacted
 *   help       Show help documentation
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ── Types ────────────────────────────────────────────────────────────────────

export const KNOWN_CREDENTIAL_TYPES = [
  "kyc",
  "age",
  "jurisdiction",
  "income",
  "funds",
  "accreditation",
  "employment",
] as const;

export type CredentialType = (typeof KNOWN_CREDENTIAL_TYPES)[number] | (string & {});

export interface Credential {
  type: CredentialType;
  title?: string;
  claim?: string;
  issuer?: string;
  issuerId: string;
  holder: string;
  value: string;
  salt: string;
  commitment: string;
  sig: number[];
  issuerPubX: number[];
  issuerPubY: number[];
  issuedAt: number;
  expiry: string;
  seniority?: string;
  claimParams?: Record<string, unknown>;
  provedAt?: number;
  provedTxHash?: string;
  deployment?: {
    network?: string;
    contractId?: string;
    [key: string]: unknown;
  };
  circuitVersion?: string;
  circuitVkVersion?: number;
  issuerStatus?: "active" | "key_retired" | "key_revoked" | "issuer_revoked" | "unknown";
  issuerStatusCheckedAt?: number;
  [key: string]: unknown;
}

export interface EncryptedBackupEnvelope {
  version: number;
  kdf?: "PBKDF2-SHA256" | "RAW";
  iterations?: number;
  salt?: string;
  iv: string;
  ciphertext: string;
  deployment?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WrappedBackup {
  version: number | string;
  exportedAt?: string;
  generator?: string;
  count?: number;
  credentials: Credential[];
  [key: string]: unknown;
}

// ── Validation Helpers ───────────────────────────────────────────────────────

/** True when string represents a BN254 scalar (hex or decimal digits). */
export function isFieldString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && /^(0x)?[0-9a-f]+$/i.test(v);
}

/** True when v is an array of exactly len bytes in [0, 255]. */
export function isByteArray(v: unknown, len: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === len &&
    v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  );
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a single credential object against the StellarCred schema.
 * Replicates the checks from frontend/lib/credential.ts without modifying data.
 */
export function validateCredential(raw: unknown, index?: number): ValidationResult {
  const errors: string[] = [];
  const prefix = index !== undefined ? `Entry #${index + 1}: ` : "";

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: [`${prefix}Credential must be a non-null object.`] };
  }

  const c = raw as Record<string, unknown>;

  if (typeof c.type !== "string" || c.type.trim().length === 0) {
    errors.push(`${prefix}Missing or empty 'type'.`);
  }

  if (!isFieldString(c.value)) {
    errors.push(`${prefix}'value' must be a non-empty numeric or 0x-hex string.`);
  }

  if (!isFieldString(c.salt)) {
    errors.push(`${prefix}'salt' must be a non-empty numeric or 0x-hex string.`);
  }

  if (!isFieldString(c.commitment)) {
    errors.push(`${prefix}'commitment' must be a non-empty numeric or 0x-hex string.`);
  }

  if (typeof c.issuerId !== "string" || c.issuerId.trim().length === 0) {
    errors.push(`${prefix}'issuerId' must be a non-empty string.`);
  }

  if (typeof c.holder !== "string" || c.holder.trim().length === 0) {
    errors.push(`${prefix}'holder' must be a non-empty string.`);
  }

  if (!isByteArray(c.sig, 64)) {
    errors.push(`${prefix}'sig' must be an array of exactly 64 byte integers [0-255].`);
  }

  if (!isByteArray(c.issuerPubX, 32)) {
    errors.push(`${prefix}'issuerPubX' must be an array of exactly 32 byte integers [0-255].`);
  }

  if (!isByteArray(c.issuerPubY, 32)) {
    errors.push(`${prefix}'issuerPubY' must be an array of exactly 32 byte integers [0-255].`);
  }

  if (typeof c.expiry !== "string" || !/\d/.test(c.expiry)) {
    errors.push(`${prefix}'expiry' must be a duration string containing numbers (e.g. "90 days").`);
  }

  if (
    c.circuitVkVersion !== undefined &&
    (!Number.isInteger(c.circuitVkVersion) || (c.circuitVkVersion as number) < 1)
  ) {
    errors.push(`${prefix}'circuitVkVersion' must be a positive integer when present.`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/** Parses and strictly validates a credential JSON string or object. */
export function parseCredential(input: string | Record<string, unknown>): Credential {
  const obj = typeof input === "string" ? JSON.parse(input) : input;
  const { valid, errors } = validateCredential(obj);
  if (!valid) {
    throw new Error(`Invalid credential:\n - ${errors.join("\n - ")}`);
  }
  return obj as Credential;
}

// ── Base64 URL Helpers ───────────────────────────────────────────────────────

export function encodeB64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function decodeB64Url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}

// ── Cryptography (PBKDF2-SHA256 & AES-256-GCM) ──────────────────────────────

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const LEGACY_PBKDF2_ITERATIONS = 100_000;
export const ENVELOPE_VERSION = 3;

/** Checks if a parsed payload is an encrypted backup envelope. */
export function isEncryptedEnvelope(value: unknown): value is EncryptedBackupEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "number" &&
    typeof v.iv === "string" &&
    typeof v.ciphertext === "string"
  );
}

/** Resolves iteration count matching SUPPORT_POLICY.md and credential-crypto.ts. */
export function resolveIterations(env: EncryptedBackupEnvelope): number {
  switch (env.version) {
    case 1:
      return LEGACY_PBKDF2_ITERATIONS;
    case 2:
      return typeof env.iterations === "number" ? env.iterations : LEGACY_PBKDF2_ITERATIONS;
    case 3:
      return typeof env.iterations === "number" ? env.iterations : DEFAULT_PBKDF2_ITERATIONS;
    default:
      if (typeof env.iterations === "number") return env.iterations;
      return DEFAULT_PBKDF2_ITERATIONS;
  }
}

/** Seals credentials into an EncryptedBackupEnvelope. */
export async function sealEncryptedBackup(
  credentials: Credential[],
  passphrase: string,
  deployment?: Record<string, unknown>,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<EncryptedBackupEnvelope> {
  if (!passphrase || passphrase.length === 0) {
    throw new Error("Passphrase must not be empty for encrypted backup.");
  }

  const saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const ivBytes = globalThis.crypto.getRandomValues(new Uint8Array(12));

  const enc = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const derivedKey = await globalThis.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  const plaintextBytes = enc.encode(JSON.stringify(credentials));
  const cipherBuffer = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBytes },
    derivedKey,
    plaintextBytes
  );

  return {
    version: ENVELOPE_VERSION,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: encodeB64Url(saltBytes),
    iv: encodeB64Url(ivBytes),
    ciphertext: encodeB64Url(new Uint8Array(cipherBuffer)),
    ...(deployment ? { deployment } : {}),
  };
}

/** Decrypts an EncryptedBackupEnvelope with the passphrase. */
export async function openEncryptedBackup(
  envelope: EncryptedBackupEnvelope,
  passphrase: string
): Promise<Credential[]> {
  if (!passphrase || passphrase.length === 0) {
    throw new Error("Passphrase required to open encrypted backup.");
  }
  if (!envelope.salt) {
    throw new Error("Invalid encrypted envelope: missing salt.");
  }

  const saltBytes = decodeB64Url(envelope.salt);
  const ivBytes = decodeB64Url(envelope.iv);
  const ciphertextBytes = decodeB64Url(envelope.ciphertext);
  const iterations = resolveIterations(envelope);

  const enc = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const derivedKey = await globalThis.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  let decryptedBytes: ArrayBuffer;
  try {
    decryptedBytes = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBytes },
      derivedKey,
      ciphertextBytes
    );
  } catch {
    throw new Error("Decryption failed: Incorrect passphrase or corrupted backup envelope.");
  }

  const plaintext = new TextDecoder().decode(decryptedBytes);
  const parsed = JSON.parse(plaintext);
  return extractCredentials(parsed);
}

// ── Payload Extraction & Merging ─────────────────────────────────────────────

/**
 * Extracts a Credential array from any supported format:
 * - Direct Credential[]
 * - Wrapped backup envelope ({ version, credentials: [] })
 * - Single Credential object
 * - Legacy export format ({ entries: [] })
 */
export function extractCredentials(data: unknown): Credential[] {
  if (!data) return [];

  if (Array.isArray(data)) {
    return data as Credential[];
  }

  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.credentials)) {
      return obj.credentials as Credential[];
    }
    if (Array.isArray(obj.entries)) {
      return obj.entries as Credential[];
    }
    // Single credential check
    if (typeof obj.type === "string" && obj.commitment) {
      return [obj as unknown as Credential];
    }
  }

  throw new Error("Unrecognized credential payload structure.");
}

/**
 * Merges incoming credentials into an existing list.
 * Deduplicates by (type + commitment), preserving newer or incoming records.
 * Identical behavior to saveCredential in frontend/lib/credential.ts.
 */
export function mergeCredentials(existing: Credential[], incoming: Credential[]): Credential[] {
  let result = [...existing];
  for (const cred of incoming) {
    result = [
      cred,
      ...result.filter((c) => !(c.type === cred.type && c.commitment === cred.commitment)),
    ];
  }
  return result;
}

// ── Core Operations ──────────────────────────────────────────────────────────

export interface ReadOptions {
  passphrase?: string;
}

export interface ReadResult {
  credentials: Credential[];
  isEncrypted: boolean;
  version?: number | string;
  rawPayload: unknown;
}

/** Reads and parses a backup or credential file from disk. */
export async function readCredentialSource(
  filePath: string,
  options: ReadOptions = {}
): Promise<ReadResult> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) {
    throw new Error(`File is empty: ${filePath}`);
  }

  const parsed = JSON.parse(content);

  if (isEncryptedEnvelope(parsed)) {
    const pass = options.passphrase || process.env.CREDENTIAL_PASSPHRASE;
    if (!pass) {
      throw new Error(
        `File '${filePath}' is an encrypted backup (v${parsed.version}). Passphrase is required (--passphrase or CREDENTIAL_PASSPHRASE).`
      );
    }
    const creds = await openEncryptedBackup(parsed, pass);
    return {
      credentials: creds,
      isEncrypted: true,
      version: parsed.version,
      rawPayload: parsed,
    };
  }

  const creds = extractCredentials(parsed);
  return {
    credentials: creds,
    isEncrypted: false,
    version: typeof parsed === "object" && parsed !== null && "version" in parsed ? (parsed as { version: number | string }).version : undefined,
    rawPayload: parsed,
  };
}

export interface ExportOptions {
  format?: "plain" | "encrypted";
  passphrase?: string;
  types?: string[];
  holder?: string;
  envelope?: boolean;
  pretty?: boolean;
  force?: boolean;
  generator?: string;
  deployment?: Record<string, unknown>;
}

/** Exports credentials to a designated output file. */
export async function exportCredentialsToFile(
  credentials: Credential[],
  outputPath: string,
  options: ExportOptions = {}
): Promise<{ count: number; format: string }> {
  if (!options.force && existsSync(outputPath)) {
    throw new Error(`Output file already exists: ${outputPath}. Use --force to overwrite.`);
  }

  let filtered = [...credentials];
  if (options.types && options.types.length > 0) {
    const typeSet = new Set(options.types.map((t) => t.toLowerCase()));
    filtered = filtered.filter((c) => typeSet.has(c.type.toLowerCase()));
  }
  if (options.holder) {
    filtered = filtered.filter((c) => c.holder === options.holder);
  }

  // Validate each credential prior to export
  for (let i = 0; i < filtered.length; i++) {
    const { valid, errors } = validateCredential(filtered[i], i);
    if (!valid) {
      throw new Error(`Validation failed for export:\n - ${errors.join("\n - ")}`);
    }
  }

  const indent = options.pretty !== false ? 2 : undefined;
  const isEncrypted = options.format === "encrypted" || Boolean(options.passphrase);

  let outputText: string;

  if (isEncrypted) {
    const pass = options.passphrase || process.env.CREDENTIAL_PASSPHRASE;
    if (!pass) {
      throw new Error("Encryption requested but no passphrase provided (--passphrase or CREDENTIAL_PASSPHRASE).");
    }
    const envelope = await sealEncryptedBackup(filtered, pass, options.deployment);
    outputText = JSON.stringify(envelope, null, indent);
  } else if (options.envelope) {
    const wrapped: WrappedBackup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      generator: options.generator ?? "credential-cli",
      count: filtered.length,
      credentials: filtered,
    };
    outputText = JSON.stringify(wrapped, null, indent);
  } else {
    // Standard plain JSON array compatible with browser app downloadBackup()
    outputText = JSON.stringify(filtered, null, indent);
  }

  writeFileSync(outputPath, outputText, "utf-8");
  return { count: filtered.length, format: isEncrypted ? "encrypted" : "plain" };
}

export interface ImportOptions {
  passphrase?: string;
  merge?: boolean;
  filterTypes?: string[];
  dryRun?: boolean;
  force?: boolean;
  pretty?: boolean;
}

/** Imports credentials from a backup file into an app-compatible JSON file. */
export async function importCredentialsFromFile(
  inputPath: string,
  outputPath: string,
  options: ImportOptions = {}
): Promise<{ importedCount: number; mergedTotal: number; credentials: Credential[] }> {
  const readResult = await readCredentialSource(inputPath, {
    passphrase: options.passphrase,
  });

  let incoming = readResult.credentials;
  if (options.filterTypes && options.filterTypes.length > 0) {
    const typeSet = new Set(options.filterTypes.map((t) => t.toLowerCase()));
    incoming = incoming.filter((c) => typeSet.has(c.type.toLowerCase()));
  }

  // Validate all incoming credentials
  for (let i = 0; i < incoming.length; i++) {
    const { valid, errors } = validateCredential(incoming[i], i);
    if (!valid) {
      throw new Error(`Cannot import invalid credential:\n - ${errors.join("\n - ")}`);
    }
  }

  let finalCredentials: Credential[];
  if (options.merge && existsSync(outputPath)) {
    const existing = await readCredentialSource(outputPath, {
      passphrase: options.passphrase,
    });
    finalCredentials = mergeCredentials(existing.credentials, incoming);
  } else {
    if (!options.force && !options.merge && existsSync(outputPath)) {
      throw new Error(`Output file already exists: ${outputPath}. Use --merge or --force.`);
    }
    finalCredentials = incoming;
  }

  if (!options.dryRun) {
    const indent = options.pretty !== false ? 2 : undefined;
    writeFileSync(outputPath, JSON.stringify(finalCredentials, null, indent), "utf-8");
  }

  return {
    importedCount: incoming.length,
    mergedTotal: finalCredentials.length,
    credentials: finalCredentials,
  };
}

// ── Security Warnings ────────────────────────────────────────────────────────

export function printSecurityWarning(isPlainExport: boolean) {
  process.stderr.write("\x1b[33m" + "─".repeat(72) + "\x1b[0m\n");
  process.stderr.write("\x1b[33m[SECURITY NOTICE - CONFIDENTIAL DATA]\x1b[0m\n");
  if (isPlainExport) {
    process.stderr.write(
      " Plaintext exported credentials contain private cryptographic commitments,\n" +
      " unblinded salts, and issuer signatures.\n" +
      " • Treat this JSON file with the same confidentiality as a private key.\n" +
      " • Never commit credential backups to version control or public storage.\n" +
      " • Secure file permissions (e.g. chmod 600) and delete after recovery.\n" +
      " • For off-device storage, prefer encrypted exports (--passphrase).\n"
    );
  } else {
    process.stderr.write(
      " Encrypted credential backup uses AES-256-GCM with PBKDF2-SHA256 (600k iterations).\n" +
      " • Ensure your passphrase has high entropy; forgotten passphrases cannot be recovered.\n" +
      " • Store your backup and passphrase in separate, secure locations.\n"
    );
  }
  process.stderr.write("\x1b[33m" + "─".repeat(72) + "\x1b[0m\n");
}

// ── CLI Handlers ─────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { command: string; options: Record<string, string | boolean> } {
  const options: Record<string, string | boolean> = {};
  let command = "help";

  let i = 0;
  if (args.length > 0 && !args[0].startsWith("-")) {
    command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--no-")) {
      options[arg.slice(5)] = false;
      i++;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options[key] = next;
        i += 2;
      } else {
        options[key] = true;
        i++;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options[key] = next;
        i += 2;
      } else {
        options[key] = true;
        i++;
      }
    } else {
      i++;
    }
  }

  return { command, options };
}

export function printHelp() {
  process.stdout.write(`
StellarCred Offline Credential CLI (#811)

Usage:
  credential-cli <command> [options]

Commands:
  export     Export credentials to plain or encrypted JSON backup file
  import     Import credentials from backup file into app-compatible JSON
  validate   Verify credential schema and cryptographic structure
  inspect    Display credential details offline with sensitive fields redacted
  help       Show this help message

Export Options:
  -i, --input <file>        Input credential or backup JSON file (required)
  -o, --output <file>       Destination output backup file (required)
  -f, --format <format>     Output format: 'plain' (default) or 'encrypted'
  -p, --passphrase <pass>   Passphrase for encrypted export (or CREDENTIAL_PASSPHRASE env)
  -t, --type <types>        Filter by comma-separated credential types (e.g. 'kyc,age')
  --holder <address>        Filter credentials by holder address
  --envelope                Wrap plain output in metadata envelope
  --no-pretty               Output minified JSON
  --force                   Overwrite output file if it exists

Import Options:
  -i, --input <file>        Source backup file to import (required)
  -o, --output <file>       Destination JSON file for app (required)
  -p, --passphrase <pass>   Passphrase if input is encrypted
  -m, --merge               Merge into existing output file (deduplicating by type+commitment)
  -t, --filter-type <types> Filter imported types (comma-separated)
  --dry-run                 Validate and preview without writing
  --force                   Overwrite output file if not merging

Validate Options:
  -i, --input <file>        Credential or backup file to validate (required)
  -p, --passphrase <pass>   Passphrase if input is encrypted

Inspect Options:
  -i, --input <file>        Backup or credential file to inspect (required)
  -p, --passphrase <pass>   Passphrase if input is encrypted
  --show-sensitive          Reveal unblinded salts, values, and full signatures

Examples:
  # Export plain credentials backup compatible with browser app:
  credential-cli export -i credentials.json -o backup.json

  # Export encrypted backup with passphrase:
  credential-cli export -i credentials.json -o backup.enc.json -p "my-passphrase"

  # Import backup and merge into credentials store:
  credential-cli import -i backup.json -o credentials.json --merge

  # Dry-run inspect a backup file:
  credential-cli inspect -i backup.json
`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { command, options } = parseArgs(argv);

  switch (command) {
    case "export": {
      const input = (options.input || options.i) as string | undefined;
      const output = (options.output || options.o) as string | undefined;
      if (!input || !output) {
        throw new Error("Missing required arguments: --input and --output are required for export.");
      }
      const passphrase = (options.passphrase || options.p) as string | undefined;
      const format = ((options.format || options.f) as string | undefined) ?? (passphrase ? "encrypted" : "plain");
      const types = (options.type || options.t)
        ? String(options.type || options.t).split(",").map((s) => s.trim())
        : undefined;
      const holder = options.holder as string | undefined;
      const envelope = Boolean(options.envelope);
      const force = Boolean(options.force);
      const pretty = options.pretty !== false;

      printSecurityWarning(format !== "encrypted");

      const source = await readCredentialSource(input, { passphrase });
      const result = await exportCredentialsToFile(source.credentials, output, {
        format: format as "plain" | "encrypted",
        passphrase,
        types,
        holder,
        envelope,
        pretty,
        force,
      });

      console.log(`[Export Success] Exported ${result.count} credential(s) in ${result.format} format to ${output}`);
      break;
    }

    case "import": {
      const input = (options.input || options.i) as string | undefined;
      const output = (options.output || options.o) as string | undefined;
      if (!input || !output) {
        throw new Error("Missing required arguments: --input and --output are required for import.");
      }
      const passphrase = (options.passphrase || options.p) as string | undefined;
      const merge = Boolean(options.merge || options.m);
      const dryRun = Boolean(options["dry-run"]);
      const force = Boolean(options.force);
      const pretty = options.pretty !== false;
      const filterTypes = (options["filter-type"] || options.t)
        ? String(options["filter-type"] || options.t).split(",").map((s) => s.trim())
        : undefined;

      const result = await importCredentialsFromFile(input, output, {
        passphrase,
        merge,
        dryRun,
        force,
        pretty,
        filterTypes,
      });

      if (dryRun) {
        console.log(`[Dry Run] Successfully validated ${result.importedCount} credential(s) from ${input}. No files written.`);
      } else {
        console.log(
          `[Import Success] Imported ${result.importedCount} credential(s) from ${input} -> ${output} (Total stored: ${result.mergedTotal})`
        );
      }
      break;
    }

    case "validate": {
      const input = (options.input || options.i) as string | undefined;
      if (!input) {
        throw new Error("Missing required argument: --input is required for validate.");
      }
      const passphrase = (options.passphrase || options.p) as string | undefined;

      console.log(`Validating ${input}...`);
      const source = await readCredentialSource(input, { passphrase });
      console.log(`Type: ${source.isEncrypted ? `Encrypted envelope (v${source.version})` : "Plain JSON"}`);

      let validCount = 0;
      let invalidCount = 0;

      source.credentials.forEach((cred, idx) => {
        const { valid, errors } = validateCredential(cred, idx);
        if (valid) {
          validCount++;
        } else {
          invalidCount++;
          console.error(`Invalid credential #${idx + 1} (${cred.type || "unknown"}):`);
          errors.forEach((e) => console.error(`  - ${e}`));
        }
      });

      console.log(`Validation complete: ${validCount} valid, ${invalidCount} invalid out of ${source.credentials.length} total.`);
      if (invalidCount > 0) {
        process.exitCode = 1;
      }
      break;
    }

    case "inspect": {
      const input = (options.input || options.i) as string | undefined;
      if (!input) {
        throw new Error("Missing required argument: --input is required for inspect.");
      }
      const passphrase = (options.passphrase || options.p) as string | undefined;
      const showSensitive = Boolean(options["show-sensitive"]);

      const source = await readCredentialSource(input, { passphrase });
      console.log(`[Inspect] File: ${input}`);
      console.log(`[Inspect] Format: ${source.isEncrypted ? `Encrypted envelope (v${source.version})` : "Plain JSON"}`);
      console.log(`[Inspect] Total credentials: ${source.credentials.length}`);
      console.log("─".repeat(72));

      source.credentials.forEach((c, idx) => {
        const commitmentShort = c.commitment
          ? `${c.commitment.slice(0, 10)}...${c.commitment.slice(-8)}`
          : "none";
        console.log(`[#${idx + 1}] Type: ${c.type} | Title: ${c.title || "N/A"} | Claim: ${c.claim || "N/A"}`);
        console.log(`     Issuer: ${c.issuer || "N/A"} (${c.issuerId})`);
        console.log(`     Holder: ${c.holder}`);
        console.log(`     Expiry: ${c.expiry} | IssuedAt: ${new Date(c.issuedAt * 1000).toISOString()}`);
        console.log(`     Commitment: ${commitmentShort}`);
        if (c.provedAt) {
          console.log(`     ProvedAt: ${new Date(c.provedAt * 1000).toISOString()} | Tx: ${c.provedTxHash || "N/A"}`);
        }
        if (c.deployment) {
          console.log(`     Deployment: ${c.deployment.network || "custom"}`);
        }
        if (showSensitive) {
          console.log(`     [SENSITIVE] Salt: ${c.salt}`);
          console.log(`     [SENSITIVE] Value: ${c.value}`);
          console.log(`     [SENSITIVE] Sig: [${c.sig?.length ?? 0} bytes]`);
        } else {
          console.log(`     [SENSITIVE] Salt & Value: <redacted - use --show-sensitive to view>`);
        }
        console.log("─".repeat(72));
      });
      break;
    }

    case "help":
    default:
      printHelp();
      break;
  }
}

// Check if running directly as CLI script
const isDirectRun =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
    process.argv[1].replace(/\\/g, "/").endsWith("scripts/credential-cli.ts"));

if (isDirectRun) {
  main().catch((err) => {
    console.error(`\x1b[31merror:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
