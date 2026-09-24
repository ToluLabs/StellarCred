"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { CREDENTIAL_TYPES, type CredentialType } from "./stellar";
import { isStorageAvailable } from "./safe-storage";

export interface ClaimParams {
  threshold_years?: string;
  threshold?: string;
  restricted?: string[];
  /** "0" = denylist/block (default), "1" = allowlist/allow */
  mode?: string;
}

export interface Credential {
  type: CredentialType;
  title: string;
  claim: string;
  issuer: string;
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
  /**
   * Issuer-attested tenure (years), set on `employment` credentials so the
   * holder can prove `seniority >= min_seniority` against the issuer's signed
   * commitment. Required for employment; absent for other types.
   */
  seniority?: string;
  /** Protocol-specific proof parameters (e.g. age threshold, restricted list). */
  claimParams?: ClaimParams;
  /** Unix timestamp (seconds) when the proof was last successfully submitted. */
  provedAt?: number;
  /** Transaction hash of the last submitted proof. */
  provedTxHash?: string;
}

export const TYPE_META: Record<
  CredentialType,
  { title: string; claim: string; issuable: boolean; attribute?: string }
> = {
  kyc: { title: "KYC Complete", claim: "identity verified", issuable: true },
  age: {
    title: "Age Verified",
    claim: "age ≥ 18",
    issuable: true,
    attribute: "Date of birth",
  },
  income: {
    title: "Accredited (Income)",
    claim: "income > $200,000",
    issuable: true,
    attribute: "Annual income (USD)",
  },
  jurisdiction: {
    title: "Jurisdiction Eligible",
    claim: "country not restricted",
    issuable: true,
    attribute: "Country (ISO numeric)",
  },
  funds: {
    title: "Proof of Funds",
    claim: "balance > $10,000",
    issuable: true,
    attribute: "Account balance (USD)",
  },
  accreditation: {
    title: "Accredited Investor",
    claim: "net worth ≥ $1,000,000",
    issuable: true,
    attribute: "Net worth (USD)",
  },
  employment: {
    title: "Employed",
    claim: "employed, seniority ≥ 3",
    issuable: true,
    attribute: "Seniority (years)",
  },
};

// BN254 scalar field is ~254 bits; 31 random bytes (248 bits) is always in range.
export function randomField(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

// ---- At-rest encryption (AES-256-GCM + PBKDF2) ------------------------------
//
// The AES key is derived from a user passphrase via PBKDF2-SHA256 (100k
// iterations). The passphrase never leaves the browser; the derived key lives
// only in a module-level variable for the duration of the session. The
// encrypted envelope stored in localStorage contains the salt and IV so the
// key can be re-derived on the next unlock.
//
// This design satisfies #284: an XSS that reads localStorage gets only the
// encrypted envelope — it does not have the passphrase and cannot derive the
// key. It also solves the data-loss problem from #336: the key is no longer
// stored in sessionStorage (which is cleared on browser close), so
// re-entering the passphrase on the next session re-derives the same key
// and successfully decrypts the existing ciphertext.

/**
 * localStorage key under which all credentials are persisted. Credentials
 * (including the raw `value` / `salt` secrets) live ONLY in this browser's
 * localStorage — they are never stored on a server. See the README's
 * "Where your credentials live" section for the full model and the
 * backup/restore flow.
 *
 * Values stored under this key are AES-256-GCM encrypted at rest with a
 * PBKDF2-derived key. The raw credential value and salt are never written
 * to localStorage in plaintext.
 */
export const CREDENTIALS_STORAGE_KEY = "stellarcred:credentials";

const STORE_KEY = CREDENTIALS_STORAGE_KEY;

/** PBKDF2 iteration count — aligned with lib/backup.ts (OWASP guidance). */
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/**
 * Envelope written to localStorage. The salt and IV travel with the
 * ciphertext so the key can be re-derived from the same passphrase.
 */
interface EncryptedEnvelope {
  version: 1;
  salt: string;       // base64
  iv: string;         // base64
  ciphertext: string; // base64
}

// ---- In-memory key cache (not persisted) ------------------------------------
let _cachedKey: CryptoKey | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Derive an AES-256-GCM key from a passphrase via PBKDF2-SHA256. */
async function deriveAtRestKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new Uint8Array(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// Store the salt used at unlock time so encrypt can embed it in envelopes.
let _unlockSalt: Uint8Array | null = null;

async function encryptWithCachedKey(plaintext: string): Promise<EncryptedEnvelope> {
  if (!_cachedKey || !_unlockSalt) {
    throw new Error(
      "Credential store is locked. Call unlockCredentialStore(passphrase) first.",
    );
  }
  const ivBytes = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: ivBytes as BufferSource },
      _cachedKey,
      encoded,
    ),
  );

  return {
    version: 1,
    salt: toBase64(_unlockSalt),
    iv: toBase64(ivBytes),
    ciphertext: toBase64(ciphertext),
  };
}

async function decryptWithCachedKey(
  envelope: EncryptedEnvelope,
): Promise<string> {
  if (!_cachedKey) {
    throw new Error(
      "Credential store is locked. Call unlockCredentialStore(passphrase) first.",
    );
  }
  const iv = fromBase64(envelope.iv);
  const ciphertext = fromBase64(envelope.ciphertext);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    _cachedKey,
    ciphertext as BufferSource,
  );

  return new TextDecoder().decode(decrypted);
}

// ---- Public unlock / lock API -----------------------------------------------

/**
 * Unlock the credential store by deriving the AES key from a user passphrase.
 * Call this once at the start of each session (or whenever the user provides
 * their passphrase). The derived key lives only in memory and is never
 * persisted.
 *
 * @throws if the passphrase cannot decrypt existing credentials.
 */
export async function unlockCredentialStore(passphrase: string): Promise<void> {
  if (typeof window === "undefined") return;

  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) {
    // No existing data — derive key for future use.
    const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const key = await deriveAtRestKey(passphrase, saltBytes);
    _cachedKey = key;
    _unlockSalt = saltBytes;
    return;
  }

  // Try new envelope format first.
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      typeof parsed.salt === "string" &&
      typeof parsed.iv === "string" &&
      typeof parsed.ciphertext === "string"
    ) {
      const salt = fromBase64(parsed.salt);
      const key = await deriveAtRestKey(passphrase, salt);

      // Verify the passphrase by attempting decryption.
      const iv = fromBase64(parsed.iv);
      const ciphertext = fromBase64(parsed.ciphertext);
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        key,
        ciphertext as BufferSource,
      );

      _cachedKey = key;
      _unlockSalt = salt;
      return;
    }
  } catch {
    // Not a valid envelope — fall through.
  }

  // Try legacy plaintext JSON (pre-encryption data).
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy plaintext — accept the passphrase and re-encrypt on next save.
      const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
      const key = await deriveAtRestKey(passphrase, saltBytes);
      _cachedKey = key;
      _unlockSalt = saltBytes;
      return;
    }
  } catch {
    // Not plaintext — fall through.
  }

  // Try old broken sessionStorage-based encryption format (for migration).
  // If the data is a non-JSON base64 blob, it was encrypted with the old
  // random key. We cannot decrypt it without that key, so we treat it as
  // corrupted and accept the passphrase for fresh use.
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const key = await deriveAtRestKey(passphrase, saltBytes);
  _cachedKey = key;
  _unlockSalt = saltBytes;
}

/** Lock the credential store, clearing the derived key from memory. */
export function lockCredentialStore(): void {
  _cachedKey = null;
  _unlockSalt = null;
}

/** Returns true when the credential store has a key in memory. */
export function isCredentialStoreUnlocked(): boolean {
  return _cachedKey !== null;
}

// ---- Local wallet (this browser) --------------------------------------------

/**
 * Load credentials from localStorage.
 *
 * Handles three storage formats:
 * 1. New PBKDF2 envelope (requires unlocked store)
 * 2. Legacy plaintext JSON array (pre-encryption migration)
 * 3. Old sessionStorage-based encryption (broken — returns empty, user
 *    should re-import credentials after unlock)
 *
 * When the store is locked and encrypted data exists, returns [] and the
 * UI should prompt for the passphrase via `unlockCredentialStore()`.
 */
export async function loadCredentials(): Promise<Credential[]> {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return [];

  // Legacy plaintext fallback: if the stored value is valid JSON array,
  // return it directly. Migration to encrypted storage happens on the next
  // save (saveCredential / markProved / etc.) so we don't race with tests
  // or other tabs that are also reading.
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Not plaintext JSON, fall through to decryption.
  }

  // New PBKDF2 envelope format.
  if (_cachedKey) {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.version === 1 &&
        typeof parsed.salt === "string" &&
        typeof parsed.iv === "string" &&
        typeof parsed.ciphertext === "string"
      ) {
        const decrypted = await decryptWithCachedKey(parsed as EncryptedEnvelope);
        return JSON.parse(decrypted);
      }
    } catch {
      // Decryption failed or malformed — return empty.
    }
  }

  // Old broken format or locked store — cannot decrypt.
  return [];
}

/**
 * Serialize every locally stored credential to a JSON string for backup.
 * Pairs with the holder page's "Import credential JSON" flow: the exported
 * file's contents can be pasted back (or into another browser) to restore.
 * The export contains the sensitive attribute values, so it must be handled
 * like a password.
 */
export async function exportCredentials(): Promise<string> {
  return JSON.stringify(await loadCredentials(), null, 2);
}

/**
 * Save a credential, encrypting the full credential set with the
 * passphrase-derived key. The store must be unlocked first.
 */
export async function saveCredential(cred: Credential): Promise<Credential[]> {
  const all = await loadCredentials();
  const next = [
    cred,
    ...all.filter(
      (c) => !(c.type === cred.type && c.commitment === cred.commitment),
    ),
  ];
  localStorage.setItem(STORE_KEY, await serializeEncrypted(JSON.stringify(next)));
  return next;
}

export async function markProved(commitment: string, txHash: string): Promise<Credential[]> {
  const all = await loadCredentials();
  const next = all.map((c) =>
    c.commitment === commitment
      ? { ...c, provedAt: Math.floor(Date.now() / 1000), provedTxHash: txHash }
      : c,
  );
  localStorage.setItem(STORE_KEY, await serializeEncrypted(JSON.stringify(next)));
  return next;
}

/** Mark multiple credentials as proved in a single localStorage write. */
export async function markAllProved(
  commitments: string[],
  txHash: string,
): Promise<Credential[]> {
  const set = new Set(commitments);
  const now = Math.floor(Date.now() / 1000);
  const all = await loadCredentials();
  const next = all.map((c) =>
    set.has(c.commitment) ? { ...c, provedAt: now, provedTxHash: txHash } : c,
  );
  localStorage.setItem(STORE_KEY, await serializeEncrypted(JSON.stringify(next)));
  return next;
}

export async function removeCredential(commitment: string): Promise<Credential[]> {
  const all = await loadCredentials();
  const next = all.filter((c) => c.commitment !== commitment);
  localStorage.setItem(STORE_KEY, await serializeEncrypted(JSON.stringify(next)));
  return next;
}

/**
 * Encrypt plaintext and serialize to a JSON string for localStorage.
 * Requires the store to be unlocked (via `unlockCredentialStore`).
 */
async function serializeEncrypted(plaintext: string): Promise<string> {
  if (!_cachedKey) {
    throw new Error(
      "Credential store is locked. Call unlockCredentialStore(passphrase) first.",
    );
  }
  const envelope = await encryptWithCachedKey(plaintext);
  return JSON.stringify(envelope);
}

// BN254 field scalars are expressed as strings — either a base-10 integer or a
// 0x-prefixed hex token (see `randomField`). Reject anything else (empty
// strings, junk, arrays, objects) at the boundary so malformed imports never
// reach localStorage or blow up later in witness/proof generation.
function isFieldString(v: unknown): v is string {
  return typeof v === "string" && /^(0x)?[0-9a-f]+$/i.test(v);
}

/**
 * Validate a serialized credential as it crosses the trust boundary.
 *
 * This is the entry point for imported and QR-scanned credentials (untrusted
 * input). Beyond presence checks it enforces the exact structure the witness
 * and proof pipeline depends on, rejecting malformed input with a message that
 * names the offending field so nothing invalid is ever persisted.
 */
export function parseCredential(json: string): Credential {
  const c = JSON.parse(json) as Record<string, unknown>;

  if (
    typeof c.type !== "string" ||
    !(CREDENTIAL_TYPES as readonly string[]).includes(c.type)
  ) {
    throw new Error(
      `Not a valid credential: type must be one of ${CREDENTIAL_TYPES.join(", ")}.`,
    );
  }
  if (!isFieldString(c.value)) {
    throw new Error("Not a valid credential: value must be a non-empty numeric/field string.");
  }
  if (!isFieldString(c.salt)) {
    throw new Error("Not a valid credential: salt must be a non-empty numeric/field string.");
  }
  if (!isFieldString(c.commitment)) {
    throw new Error("Not a valid credential: commitment must be a non-empty numeric/field string.");
  }
  if (typeof c.issuerId !== "string" || c.issuerId.length === 0) {
    throw new Error("Not a valid credential: issuerId must be a non-empty string.");
  }
  if (!isByteArray(c.sig, 64)) {
    throw new Error("Not a valid credential: sig must be an array of 64 bytes, each an integer in [0, 255].");
  }
  if (!isByteArray(c.issuerPubX, 32)) {
    throw new Error("Not a valid credential: issuerPubX must be an array of 32 bytes, each an integer in [0, 255].");
  }
  if (!isByteArray(c.issuerPubY, 32)) {
    throw new Error("Not a valid credential: issuerPubY must be an array of 32 bytes, each an integer in [0, 255].");
  }
  // Expiry is a duration string (e.g. "90 days") that the holder page turns
  // into a TTL by extracting its leading number — reject anything that has no
  // digit to parse.
  if (typeof c.expiry !== "string" || !/\d/.test(c.expiry)) {
    throw new Error("Not a valid credential: expiry must be a parseable string (e.g. \"90 days\").");
  }

  return c as unknown as Credential;
}

/** True when `v` is an array of exactly `len` integer bytes in the range [0, 255]. */
function isByteArray(v: unknown, len: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === len &&
    v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  );
}

// ---- Cross-tab sync hook ---------------------------------------------------

/**
 * React hook that syncs credentials across browser tabs.
 * Listens for localStorage 'storage' events (which fire in other tabs on write)
 * and reloads the credential list when the relevant key changes.
 * Debounced to avoid thrash on batch writes. Guarded by safe-storage check.
 */
export function useCredentialSync(): Credential[] {
  const [credentials, setCredentials] = useState<Credential[]>([]);

  const reload = useCallback(() => {
    loadCredentials().then(setCredentials);
  }, []);

  // Debounced reload to avoid thrash on rapid writes
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedReload = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(reload, 100); // 100ms debounce
  }, [reload]);

  // Initial load on mount
  useEffect(() => {
    reload();
  }, [reload]);

  // Listen for storage events from other tabs
  useEffect(() => {
    if (!isStorageAvailable()) return;

    const handleStorage = (e: StorageEvent) => {
      // Only reload if the credentials key changed
      if (e.key === STORE_KEY) {
        debouncedReload();
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [debouncedReload]);

  return credentials;
}