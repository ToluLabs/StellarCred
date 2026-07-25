"use client";

import type { CredentialType } from "./stellar";

export interface ClaimParams {
  threshold_years?: string;
  threshold?: string;
  restricted?: string[];
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
  age: { title: "Age Verified", claim: "age ≥ 18", issuable: true, attribute: "Date of birth" },
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

const KEY = "stellarcred:credentials";

export function loadCredentials(): Credential[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveCredential(cred: Credential): Credential[] {
  const all = loadCredentials();
  const next = [
    cred,
    ...all.filter((c) => !(c.type === cred.type && c.commitment === cred.commitment)),
  ];
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function markProved(commitment: string, txHash: string): Credential[] {
  const next = loadCredentials().map((c) =>
    c.commitment === commitment
      ? { ...c, provedAt: Math.floor(Date.now() / 1000), provedTxHash: txHash }
      : c,
  );
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

/** Mark multiple credentials as proved in a single localStorage write. */
export function markAllProved(commitments: string[], txHash: string): Credential[] {
  const set = new Set(commitments);
  const now = Math.floor(Date.now() / 1000);
  const next = loadCredentials().map((c) =>
    set.has(c.commitment)
      ? { ...c, provedAt: now, provedTxHash: txHash }
      : c,
  );
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function removeCredential(commitment: string): Credential[] {
  const next = loadCredentials().filter((c) => c.commitment !== commitment);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function parseCredential(json: string): Credential {
  const c = JSON.parse(json);
  if (!c.type || c.value === undefined || !c.commitment || !c.issuerId || !c.sig) {
    throw new Error("Not a valid credential (missing type, value, commitment, issuerId, or sig).");
  }
  return c as Credential;
}
