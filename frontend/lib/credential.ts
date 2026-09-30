"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { CREDENTIAL_TYPES, type CredentialType } from "./stellar";
import { deploymentMismatchMessage, type DeploymentRef } from "./deployment";
import { circuitVersionMismatchMessage } from "./circuit-versions";
import { isStorageAvailable } from "./safe-storage";
import {
  ENVELOPE_VERSION,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  decodeB64,
  derivePassphraseKey,
  isCredentialEnvelope,
  openWithKey,
  resolveEnvelopeIterations,
  sealWithKey,
  type CredentialEnvelope,
} from "./credential-crypto";

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
  /**
   * The StellarCred deployment (network + contract IDs) that issued this
   * credential, stamped by /api/issue at mint time. Import paths validate it
   * against the current app config so a credential from another deployment
   * fails at import instead of confusingly at proof submission (#545).
   * Absent on credentials minted before this field existed.
   */
  deployment?: DeploymentRef;
  /**
   * The circuit version this credential was issued against (#633). A circuit
   * source change can alter the public-input layout, and nothing else on the
   * credential would reveal that the circuit which can prove it has been
   * superseded — the only symptom would be an invalid witness at prove time.
   * Stamped by /api/issue and checked before every proof; absent on
   * credentials minted before this field existed.
   */
  circuitVersion?: string;
  /**
   * The `CredentialVerifier` VK version paired with {@link circuitVersion},
   * so the credential → circuit → VK chain is explicit on the credential
   * itself rather than implied by whichever app build happens to be running.
   */
  circuitVkVersion?: number;
  /**
   * Last-checked status of this credential's issuer in IssuerRegistry (#626).
   *
   * - `"active"` — issuer is registered and trusted; credential is provable.
   * - `"key_retired"` — issuer rotated to a new key; this credential's key
   *   is still inside its validity window; proving still works.
   * - `"key_revoked"` — issuer's signing key was emergency-revoked; new
   *   proof submissions may fail with `IssuerKeyMismatch`.
   * - `"issuer_revoked"` — issuer permanently removed from registry;
   *   proof submission will fail with `IssuerNotTrusted`; the holder must
   *   obtain a fresh credential from another issuer.
   * - `"unknown"` — status could not be determined (offline / not configured).
   *
   * Absent when the status has never been checked (treated as "unknown" by UI).
   * Updated in the background by `useIssuerStatus` when the wallet is
   * connected; stored with the credential so the signal persists across sessions.
   */
  issuerStatus?: "active" | "key_retired" | "key_revoked" | "issuer_revoked" | "unknown";
  /**
   * Unix timestamp (seconds) when `issuerStatus` was last fetched from the
   * chain. Used to avoid redundant re-checks on every page load.
   */
  issuerStatusCheckedAt?: number;
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
    attribute: "Aggregate balance across linked accounts (USD)",
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

// ---- At-rest encryption (consolidated scheme, lib/credential-crypto.ts) ----
//
// The AES key is derived from a user passphrase via the single PBKDF2-SHA256
// path (#547). The passphrase never leaves the browser; the derived key lives
// only in a module-level variable for the duration of the session. The
// encrypted envelope stored in localStorage is a version-3 credential
// envelope carrying the salt and iterations so the key can be re-derived on
// the next unlock. Stores written before the consolidation carry the legacy
// version-1 envelope (100k iterations) and are migrated on unlock.
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

// ---- In-memory key cache (not persisted) ------------------------------------
let _cachedKey: CryptoKey | null = null;

// Salt the cached key was derived with, so saves can embed it in envelopes.
let _unlockSalt: Uint8Array | null = null;

/** Cache a fresh current-scheme key (600k PBKDF2) derived from the passphrase. */
async function setFreshKey(passphrase: string): Promise<void> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  _cachedKey = await derivePassphraseKey(passphrase, saltBytes);
  _unlockSalt = saltBytes;
}

async function encryptWithCachedKey(plaintext: string): Promise<CredentialEnvelope> {
  if (!_cachedKey || !_unlockSalt) {
    throw new Error(
      "Credential store is locked. Call unlockCredentialStore(passphrase) first.",
    );
  }
  return sealWithKey(plaintext, _cachedKey, {
    kdf: "PBKDF2-SHA256",
    salt: _unlockSalt,
    iterations: PBKDF2_ITERATIONS,
  });
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
    await setFreshKey(passphrase);
    return;
  }

  // Credential envelope — current (v3) or legacy (v1, pre-#547, 100k
  // iterations). Verify the passphrase by attempting decryption.
  try {
    const parsed = JSON.parse(raw);
    if (isCredentialEnvelope(parsed) && typeof parsed.salt === "string") {
      const salt = decodeB64(parsed.salt);
      const iterations = resolveEnvelopeIterations(parsed);
      const key = await derivePassphraseKey(passphrase, salt, iterations);
      const plaintext = await openWithKey(parsed, key);

      if (
        parsed.version === ENVELOPE_VERSION &&
        parsed.kdf === "PBKDF2-SHA256" &&
        iterations === PBKDF2_ITERATIONS
      ) {
        _cachedKey = key;
        _unlockSalt = salt;
        return;
      }

      // Legacy envelope — migrate to the current scheme with a fresh salt
      // while the passphrase is in hand.
      await setFreshKey(passphrase);
      localStorage.setItem(STORE_KEY, JSON.stringify(await encryptWithCachedKey(plaintext)));
      return;
    }
  } catch {
    // Not a valid envelope, or the passphrase failed to decrypt — fall through.
  }

  // Try legacy plaintext JSON (pre-encryption data).
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy plaintext — accept the passphrase and re-encrypt on next save.
      await setFreshKey(passphrase);
      return;
    }
  } catch {
    // Not plaintext — fall through.
  }

  // Try old broken sessionStorage-based encryption format (for migration).
  // If the data is a non-JSON base64 blob, it was encrypted with the old
  // random key. We cannot decrypt it without that key, so we treat it as
  // corrupted and accept the passphrase for fresh use.
  await setFreshKey(passphrase);
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
 * 1. Credential envelope (lib/credential-crypto.ts; requires unlocked store)
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

  // Credential envelope (v3 current; a v1 blob left by another tab before
  // its unlock migration is still readable with the cached key).
  if (_cachedKey) {
    try {
      const parsed = JSON.parse(raw);
      if (isCredentialEnvelope(parsed)) {
        const decrypted = await openWithKey(parsed, _cachedKey);
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

async function persistCredentials(next: Credential[]): Promise<void> {
  if (_cachedKey && _unlockSalt) {
    localStorage.setItem(STORE_KEY, await serializeEncrypted(JSON.stringify(next)));
  } else {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  }
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
  await persistCredentials(next);
  return next;
}

export async function markProved(commitment: string, txHash: string): Promise<Credential[]> {
  const all = await loadCredentials();
  const next = all.map((c) =>
    c.commitment === commitment
      ? { ...c, provedAt: Math.floor(Date.now() / 1000), provedTxHash: txHash }
      : c,
  );
  await persistCredentials(next);
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
  await persistCredentials(next);
  return next;
}

export async function removeCredential(commitment: string): Promise<Credential[]> {
  const all = await loadCredentials();
  const next = all.filter((c) => c.commitment !== commitment);
  await persistCredentials(next);
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
  // Cross-deployment guard (#545): a credential minted against another
  // network or another set of contract IDs can never be proven here (the
  // issuer isn't registered in this registry), so reject it at import with a
  // clear explanation instead of letting submission fail later. Credentials
  // without a deployment reference predate this field and pass through.
  const mismatch = deploymentMismatchMessage(c.deployment);
  if (mismatch) throw new Error(mismatch);

  // Circuit-compatibility guard (#633): a credential issued against a
  // superseded circuit version may no longer be expressible by the circuits
  // this app serves. Rejecting it at import — alongside the deployment guard —
  // is the earliest point at which the holder can be told, and the prove path
  // re-checks it independently. Credentials with no recorded circuit version
  // predate this field and pass through.
  const circuitMismatch = circuitVersionMismatchMessage(c.type, c.circuitVersion);
  if (circuitMismatch) throw new Error(circuitMismatch);

  // The VK version is advisory next to `circuitVersion` (the registry is
  // authoritative), but a non-integer is a corrupted credential and would
  // silently poison the credential → circuit → VK chain.
  if (
    c.circuitVkVersion !== undefined &&
    (!Number.isInteger(c.circuitVkVersion) || (c.circuitVkVersion as number) < 1)
  ) {
    throw new Error(
      "Not a valid credential: circuitVkVersion must be a positive integer when present.",
    );
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