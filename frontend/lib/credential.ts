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

// ---- At-rest encryption (AES-256-GCM) ---------------------------------------

/**
 * localStorage key under which all credentials are persisted. Credentials
 * (including the raw `value` / `salt` secrets) live ONLY in this browser's
 * localStorage — they are never stored on a server. See the README's
 * "Where your credentials live" section for the full model and the
 * backup/restore flow.
 *
 * Values stored under this key are AES-256-GCM encrypted at rest; see
 * encryptBlob/decryptBlob below. The raw credential value and salt are
 * never written to localStorage in plaintext.
 */
export const CREDENTIALS_STORAGE_KEY = "stellarcred:credentials";

const STORE_KEY = CREDENTIALS_STORAGE_KEY;
const ENC_KEY_STORE = "stellarcred:cred-enc-key";

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

async function getEncryptionKey(): Promise<CryptoKey> {
  try {
    const stored = sessionStorage.getItem(ENC_KEY_STORE);
    if (stored) {
      const raw = fromBase64(stored);
      return crypto.subtle.importKey(
        "raw",
        raw as BufferSource,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    }
  } catch {
    sessionStorage.removeItem(ENC_KEY_STORE);
    localStorage.removeItem(STORE_KEY);
  }

  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );

  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  sessionStorage.setItem(ENC_KEY_STORE, toBase64(raw));

  return key;
}

async function encryptBlob(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded),
  );

  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);

  return toBase64(combined);
}

async function decryptBlob(ciphertextB64: string): Promise<string> {
  const key = await getEncryptionKey();
  const combined = fromBase64(ciphertextB64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

// ---- Local wallet (this browser) --------------------------------------------

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

  try {
    const decrypted = await decryptBlob(raw);
    return JSON.parse(decrypted);
  } catch {
    return [];
  }
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

export async function saveCredential(cred: Credential): Promise<Credential[]> {
  const all = await loadCredentials();
  const next = [
    cred,
    ...all.filter(
      (c) => !(c.type === cred.type && c.commitment === cred.commitment),
    ),
  ];
  localStorage.setItem(STORE_KEY, await encryptBlob(JSON.stringify(next)));
  return next;
}

export async function markProved(commitment: string, txHash: string): Promise<Credential[]> {
  const all = await loadCredentials();
  const next = all.map((c) =>
    c.commitment === commitment
      ? { ...c, provedAt: Math.floor(Date.now() / 1000), provedTxHash: txHash }
      : c,
  );
  localStorage.setItem(STORE_KEY, await encryptBlob(JSON.stringify(next)));
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
  localStorage.setItem(STORE_KEY, await encryptBlob(JSON.stringify(next)));
  return next;
}

export async function removeCredential(commitment: string): Promise<Credential[]> {
  const all = await loadCredentials();
  const next = all.filter((c) => c.commitment !== commitment);
  localStorage.setItem(STORE_KEY, await encryptBlob(JSON.stringify(next)));
  return next;
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