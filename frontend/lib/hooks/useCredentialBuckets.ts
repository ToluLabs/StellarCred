"use client";

/**
 * useCredentialBuckets — splits the holder's credentials into the sections the
 * holder page renders. Extracted from HolderPageClient (see #441) to keep the
 * page shell under its line cap.
 */

import { type Credential } from "../credential";
import { proofStatus, isExpiringSoon, daysRemaining } from "../proof-helpers";

/** Days before expiry at which a proved credential counts as "expiring soon". */
export const EXPIRING_SOON_DAYS = 7;

export interface CredentialBuckets {
  unproved: Credential[];
  /** Proved and expiring within EXPIRING_SOON_DAYS, soonest first. */
  expiringSoon: Credential[];
  activeProved: Credential[];
  expired: Credential[];
}

export function bucketCredentials(creds: Credential[]): CredentialBuckets {
  const proved = creds.filter((c) => proofStatus(c) === "proved");
  return {
    unproved: creds.filter((c) => proofStatus(c) === "unproved"),
    expiringSoon: proved
      .filter((c) => isExpiringSoon(c, EXPIRING_SOON_DAYS))
      .sort((a, b) => daysRemaining(a) - daysRemaining(b)),
    activeProved: proved.filter((c) => !isExpiringSoon(c, EXPIRING_SOON_DAYS)),
    expired: creds.filter((c) => proofStatus(c) === "expired"),
  };
}

/**
 * Recomputed on every render (not memoized) on purpose: the buckets depend on
 * the current time, so a credential can move to "expiring soon" or "expired"
 * while the page is open without the credential list itself changing.
 */
export function useCredentialBuckets(creds: Credential[]): CredentialBuckets {
  return bucketCredentials(creds);
}
