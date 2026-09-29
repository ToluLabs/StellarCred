// Utilities for building the issuer-side credential preview (#617).
//
// These are pure functions — no side effects, no network calls — so they are
// safe to use before the "Sign & issue" confirmation is given.
//
// The claim label logic mirrors `buildClaimLabel` in
// packages/issuer/src/index.ts; the two must stay in sync. We keep them
// separate so this file can import from `lib/` without pulling in the
// server-only `@stellarcred/issuer` package.

import type { CredentialType } from "./stellar";
import type { ClaimParams } from "./credential";

/** The full set of fields that will be committed and signed, shown in the preview. */
export interface CredentialPreviewData {
  /** Registered issuer display name. */
  issuerName: string;
  /** Stellar address of the issuer. */
  issuerId: string;
  /** Credential type, e.g. "age", "kyc". */
  type: CredentialType;
  /** Human-readable credential title, e.g. "Age Verified". */
  title: string;
  /** The claim the credential asserts, derived from type + claimParams. */
  claimLabel: string;
  /** Human-readable label for the attribute field, e.g. "Date of birth". */
  attributeLabel: string | null;
  /** The raw attribute value the issuer is attesting (pre-commitment). */
  attributeValue: string | null;
  /** Holder's Stellar address. */
  holder: string;
  /** Expiry duration string, e.g. "90 days". */
  expiry: string;
  /** Optional claim parameters that influence the circuit (threshold, etc.). */
  claimParams?: ClaimParams;
}

/**
 * Derive the human-readable claim label from `type` + `claimParams`.
 * Mirrors `buildClaimLabel` in `packages/issuer/src/index.ts`.
 */
export function buildClaimLabel(type: CredentialType, claimParams?: ClaimParams): string {
  switch (type) {
    case "age": {
      const years = claimParams?.threshold_years ?? "18";
      return `age ≥ ${years}`;
    }
    case "income": {
      const t = Number(claimParams?.threshold ?? "200000");
      return `income > $${t.toLocaleString("en-US")}`;
    }
    case "funds": {
      const t = Number(claimParams?.threshold ?? "10000");
      return `balance > $${t.toLocaleString("en-US")}`;
    }
    case "accreditation": {
      const t = Number(claimParams?.threshold ?? "1000000");
      return `net worth ≥ $${t.toLocaleString("en-US")}`;
    }
    case "employment": {
      const t = claimParams?.threshold ?? "3";
      return `employed, seniority ≥ ${t} yrs`;
    }
    case "jurisdiction":
      return claimParams?.mode === "1"
        ? "country in allowed list"
        : "country not restricted";
    case "kyc":
    default:
      return "identity verified";
  }
}

/**
 * Format an attribute value for display in the preview.
 * Returns `null` for credential types that have no attribute (kyc).
 */
export function formatAttributeDisplay(
  type: CredentialType,
  attributeValue: string,
  attributeLabel: string | null,
): string | null {
  if (!attributeLabel || !attributeValue) return null;
  switch (type) {
    case "age":
      // "Date of birth: 1995-06-15"
      return attributeValue;
    case "income":
    case "funds":
    case "accreditation": {
      const n = Number(attributeValue);
      return Number.isFinite(n)
        ? `$${n.toLocaleString("en-US")}`
        : attributeValue;
    }
    case "employment": {
      const n = Number(attributeValue);
      return Number.isFinite(n) ? `${n} year${n !== 1 ? "s" : ""}` : attributeValue;
    }
    default:
      return attributeValue;
  }
}
