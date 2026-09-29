"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { CredentialType } from "./stellar";
import { isStorageAvailable } from "./safe-storage";

export interface ClaimParams {
  threshold_years?: string;
  max_age_days?: string;
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
  date_range: {
    title: "Credential Freshness",
    claim: "issued within 90 days",
    issuable: true,
    attribute: "Issuance date",
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

// ---- Local wallet (this browser) ----------------------------------------

/**
 * localStorage key under which all credentials are persisted. Credentials
 * (including the raw `value` / `salt` secrets) live ONLY in this browser's
 * localStorage — they are never stored on a server. See the README's
 * "Where your credentials live" section for the full model and the
 * backup/restore flow.
 */
export const CREDENTIALS_STORAGE_KEY = "stellarcred:credentials";

const KEY = CREDENTIALS_STORAGE_KEY;

export function loadCredentials(): Credential[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
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
export function exportCredentials(): string {
  return JSON.stringify(loadCredentials(), null, 2);
}

export function saveCredential(cred: Credential): Credential[] {
  const all = loadCredentials();
  const next = [
    cred,
    ...all.filter(
      (c) => !(c.type === cred.type && c.commitment === cred.commitment),
    ),
  ];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode / quota exceeded) — in-memory state
    // is still returned so the UI stays consistent for this session
  }
  return next;
}

export function markProved(commitment: string, txHash: string): Credential[] {
  const next = loadCredentials().map((c) =>
    c.commitment === commitment
      ? { ...c, provedAt: Math.floor(Date.now() / 1000), provedTxHash: txHash }
      : c,
  );
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode / quota exceeded) — no-op
  }
  return next;
}

/** Mark multiple credentials as proved in a single localStorage write. */
export function markAllProved(
  commitments: string[],
  txHash: string,
): Credential[] {
  const set = new Set(commitments);
  const now = Math.floor(Date.now() / 1000);
  const next = loadCredentials().map((c) =>
    set.has(c.commitment) ? { ...c, provedAt: now, provedTxHash: txHash } : c,
  );
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode / quota exceeded) — no-op
  }
  return next;
}

export function removeCredential(commitment: string): Credential[] {
  const next = loadCredentials().filter((c) => c.commitment !== commitment);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable (private mode / quota exceeded) — no-op
  }
  return next;
}

export function parseCredential(json: string): Credential {
  const c = JSON.parse(json);
  if (
    !c.type ||
    c.value === undefined ||
    !c.commitment ||
    !c.issuerId ||
    !c.sig
  ) {
    throw new Error(
      "Not a valid credential (missing type, value, commitment, issuerId, or sig).",
    );
  }
  return c as Credential;
}

// ---- Cross-tab sync hook ---------------------------------------------------

/**
 * React hook that syncs credentials across browser tabs.
 * Listens for localStorage 'storage' events (which fire in other tabs on write)
 * and reloads the credential list when the relevant key changes.
 * Debounced to avoid thrash on batch writes. Guarded by safe-storage check.
 */
export function useCredentialSync(): Credential[] {
  const [credentials, setCredentials] = useState<Credential[]>(() => loadCredentials());

  // Reload credentials from localStorage
  const reload = useCallback(() => {
    setCredentials(loadCredentials());
  }, []);

  // Debounced reload to avoid thrash on rapid writes
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedReload = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(reload, 100); // 100ms debounce
  }, [reload]);

  // Listen for storage events from other tabs
  useEffect(() => {
    if (!isStorageAvailable()) return;

    const handleStorage = (e: StorageEvent) => {
      // Only reload if the credentials key changed
      if (e.key === KEY) {
        debouncedReload();
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [debouncedReload]);

  return credentials;
}
