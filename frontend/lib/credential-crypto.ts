"use client";

// lib/credential-crypto.ts — the single credential-encryption scheme (#547).
//
// Every feature that keeps credential data confidential routes through this
// one module: backup/export (lib/backup.ts), device-transfer QR codes
// (lib/transfer.ts), guardian recovery (lib/guardian.ts, whose wrap key is
// split with Shamir in lib/shamir.ts), and the at-rest store
// (lib/credential.ts). It owns the only PBKDF2 key derivation, the only
// AES-256-GCM seal/open, the versioned envelope format, and the base64
// helpers. A new confidentiality feature should extend this module (new kdf
// id or envelope version) — not grow its own copy of the scheme.
//
// JSON envelope versions (only ever add; never reinterpret an existing one,
// so artifacts written by older builds keep decrypting):
//   1 — legacy passphrase envelope: PBKDF2-SHA256 at 100k iterations
//       (v1 backup files; the pre-consolidation at-rest store).
//   2 — legacy passphrase envelope carrying its own `iterations`
//       (v2 backup files).
//   3 — current: explicit `kdf` — "PBKDF2-SHA256" with a stored `salt`/
//       `iterations` (default cost 600k, OWASP guidance) or "RAW" for
//       key-wrapped payloads (guardian) whose key is presented directly
//       rather than derived from a passphrase.
//
// The compact serialization (single base64url string, byte layout
// [version][salt][iv][ciphertext]) is the transfer-code wire format from
// the old lib/crypto.ts. Its version byte stays 1 — its parameters already
// match the current scheme (600k PBKDF2-SHA256, 16-byte salt, 12-byte IV,
// AES-256-GCM), so payloads issued before and after this consolidation
// interoperate.

export const KEY_BYTES = 32;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;

/** OWASP-recommended minimum for PBKDF2-HMAC-SHA256 (2023+). */
export const PBKDF2_ITERATIONS = 600_000;

/** Iteration count of every envelope version 1 (and of v2 backups predating the field). */
export const LEGACY_PBKDF2_ITERATIONS = 100_000;

export const ENVELOPE_VERSION = 3;

/** Byte-level version tag of the compact (transfer-code) serialization. */
const COMPACT_VERSION = 1;

export type CredentialKdf = "PBKDF2-SHA256" | "RAW";

/** Any credential envelope, current or historical. All byte fields are base64/base64url. */
export interface CredentialEnvelope {
  version: number;
  kdf?: CredentialKdf;
  iterations?: number;
  salt?: string;
  iv: string;
  ciphertext: string;
}

/** Envelope emitted by this module for new seals (version 3). */
export interface SealedEnvelope extends CredentialEnvelope {
  version: typeof ENVELOPE_VERSION;
  kdf: CredentialKdf;
}

/** Version-3 envelope sealed with a passphrase-derived key (self-describing KDF fields). */
export interface SealedPassphraseEnvelope extends SealedEnvelope {
  kdf: "PBKDF2-SHA256";
  salt: string;
  iterations: number;
}

/** Metadata annotating a seal made with an already-held CryptoKey. */
export type KeyWrapMeta =
  | { kdf: "RAW" }
  | { kdf: "PBKDF2-SHA256"; salt: Uint8Array; iterations?: number };

export class DecryptionError extends Error {
  constructor(message = "Wrong passphrase, or the code is corrupted.") {
    super(message);
    this.name = "DecryptionError";
  }
}

// ---- base64 helpers (alphabet-tolerant) -------------------------------------

export function encodeB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes standard and URL-safe base64, with or without padding. */
export function decodeB64(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- Key material ------------------------------------------------------------

/** Generates a fresh 256-bit credential key (guardian wrap keys). */
export function generateCredentialKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/**
 * The only PBKDF2 implementation in the app: passphrase → AES-256 key.
 * `iterations` must come from the envelope being opened (see
 * `resolveEnvelopeIterations`); never trust a caller-chosen cost on read.
 */
export async function derivePassphraseKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** The only raw AES-GCM key import in the app (guardian-reconstructed keys). */
export async function importCredentialKey(
  rawKey: Uint8Array,
  usages: KeyUsage[] = ["encrypt", "decrypt"],
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey as BufferSource, { name: "AES-GCM" }, false, usages);
}

/** Short integrity check for a wrap key: first 8 bytes of SHA-256, hex. */
export async function computeKeyFingerprint(keyBytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", keyBytes as BufferSource);
  return toHex(new Uint8Array(hash).slice(0, 8));
}

// ---- Envelope resolution ------------------------------------------------------

/** True for any object shaped like a credential envelope of a known version. */
export function isCredentialEnvelope(value: unknown): value is CredentialEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "number" &&
    v.version >= 1 &&
    v.version <= ENVELOPE_VERSION &&
    typeof v.iv === "string" &&
    typeof v.ciphertext === "string" &&
    (v.salt === undefined || typeof v.salt === "string")
  );
}

/**
 * The PBKDF2 cost that opened this envelope when it was written. Per-version
 * defaults reproduce each historical scheme exactly; v1 ignores any stored
 * `iterations` so a rewritten field cannot downgrade the cost.
 */
export function resolveEnvelopeIterations(env: CredentialEnvelope): number {
  switch (env.version) {
    case 1:
      return LEGACY_PBKDF2_ITERATIONS;
    case 2:
      return typeof env.iterations === "number" ? env.iterations : LEGACY_PBKDF2_ITERATIONS;
    case ENVELOPE_VERSION:
      return typeof env.iterations === "number" ? env.iterations : PBKDF2_ITERATIONS;
    default:
      throw new DecryptionError("Unsupported credential envelope version.");
  }
}

// ---- Seal / open --------------------------------------------------------------

async function gcmEncrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data as BufferSource),
  );
}

async function gcmDecrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data as BufferSource),
    );
  } catch {
    // AES-GCM authentication failure — wrong key and a tampered payload are
    // indistinguishable by design (that's the point of the tag).
    throw new DecryptionError();
  }
}

/**
 * Seals `plaintext` with an already-held key, annotating the envelope with
 * `meta` so a later reader can re-derive or re-import the same key.
 */
export async function sealWithKey(
  plaintext: string,
  key: CryptoKey,
  meta: KeyWrapMeta = { kdf: "RAW" },
): Promise<SealedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await gcmEncrypt(key, iv, new TextEncoder().encode(plaintext));
  return {
    version: ENVELOPE_VERSION,
    kdf: meta.kdf,
    ...(meta.kdf === "PBKDF2-SHA256"
      ? {
          salt: encodeB64Url(meta.salt),
          iterations: meta.iterations ?? PBKDF2_ITERATIONS,
        }
      : {}),
    iv: encodeB64Url(iv),
    ciphertext: encodeB64Url(ciphertext),
  };
}

/** Opens a key-held envelope (passphrase or raw key — the key is all `open` needs). */
export async function openWithKey(
  env: Pick<CredentialEnvelope, "iv" | "ciphertext">,
  key: CryptoKey,
): Promise<string> {
  const plaintext = await gcmDecrypt(key, decodeB64(env.iv), decodeB64(env.ciphertext));
  return new TextDecoder().decode(plaintext);
}

/** Seals a fresh passphrase envelope at the current scheme parameters (version 3). */
export async function sealWithPassphrase(
  plaintext: string,
  passphrase: string,
): Promise<SealedPassphraseEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derivePassphraseKey(passphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await gcmEncrypt(key, iv, new TextEncoder().encode(plaintext));
  return {
    version: ENVELOPE_VERSION,
    kdf: "PBKDF2-SHA256",
    salt: encodeB64Url(salt),
    iterations: PBKDF2_ITERATIONS,
    iv: encodeB64Url(iv),
    ciphertext: encodeB64Url(ciphertext),
  };
}

/** Opens version 1/2/3 passphrase envelopes with `passphrase`. */
export async function openWithPassphrase(
  env: CredentialEnvelope,
  passphrase: string,
): Promise<string> {
  if (env.kdf === "RAW") {
    throw new DecryptionError("This envelope is key-wrapped and cannot be opened with a passphrase.");
  }
  if (typeof env.salt !== "string") {
    throw new DecryptionError("Malformed credential envelope: missing KDF salt.");
  }
  const key = await derivePassphraseKey(passphrase, decodeB64(env.salt), resolveEnvelopeIterations(env));
  return openWithKey(env, key);
}

// ---- Compact (transfer-code) serialization ------------------------------------

/**
 * Passphrase seal as a single URL-safe string — `[version][salt][iv][ct]` —
 * compact enough to embed in a QR code / query param. Same scheme as
 * `sealWithPassphrase`, different serialization.
 */
export async function encryptWithPassphrase(plaintext: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await derivePassphraseKey(passphrase, salt);
  const ciphertext = await gcmEncrypt(key, iv, new TextEncoder().encode(plaintext));

  const envelope = new Uint8Array(1 + SALT_BYTES + IV_BYTES + ciphertext.length);
  envelope[0] = COMPACT_VERSION;
  envelope.set(salt, 1);
  envelope.set(iv, 1 + SALT_BYTES);
  envelope.set(ciphertext, 1 + SALT_BYTES + IV_BYTES);
  return encodeB64Url(envelope);
}

/** Reverses encryptWithPassphrase. Throws DecryptionError on a wrong passphrase or malformed payload. */
export async function decryptWithPassphrase(payload: string, passphrase: string): Promise<string> {
  let envelope: Uint8Array;
  try {
    envelope = decodeB64(payload);
  } catch {
    throw new DecryptionError("Not a valid transfer code.");
  }
  if (envelope.length < 1 + SALT_BYTES + IV_BYTES + 1 || envelope[0] !== COMPACT_VERSION) {
    throw new DecryptionError("Not a valid transfer code.");
  }

  const salt = envelope.slice(1, 1 + SALT_BYTES);
  const iv = envelope.slice(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES);
  const ciphertext = envelope.slice(1 + SALT_BYTES + IV_BYTES);
  const key = await derivePassphraseKey(passphrase, salt);
  const plaintext = await gcmDecrypt(key, iv, ciphertext);
  return new TextDecoder().decode(plaintext);
}
