/**
 * lib/issuer-choice.ts
 *
 * Pure helpers for the holder side of #620: when several registered issuers
 * can attest the same claim type, the holder picks one — and a protocol's
 * `trusted_issuers` gate decides which picks it will actually accept.
 */

import type { RegisteredIssuer } from "./issuer-registry";
import type { CredentialType } from "./stellar";

/** Registered, non-revoked issuers that can attest `type`. */
export function eligibleIssuers(
  issuers: RegisteredIssuer[],
  type: CredentialType | null | undefined,
): RegisteredIssuer[] {
  if (!type) return [];
  return issuers.filter(
    (issuer) => !issuer.revoked && issuer.credentialTypes.includes(type),
  );
}

/**
 * Whether `issuerId` satisfies the protocol's trusted-issuer gate.
 *
 * Mirrors the contract-side semantics of `trusted_issuers`: `undefined` (no
 * gate on the verify link) accepts any registered issuer, a list accepts only
 * the issuers in it.
 */
export function isProtocolAccepted(
  issuerId: string,
  trustedIssuers: string[] | undefined,
): boolean {
  if (trustedIssuers === undefined) return true;
  return trustedIssuers.includes(issuerId);
}

/**
 * The issuer to preselect for the holder: the first eligible one the protocol
 * accepts, falling back to the first eligible one when none are accepted (the
 * UI warns rather than blocking). Returns "" when nothing is eligible.
 */
export function pickDefaultIssuer(
  eligible: RegisteredIssuer[],
  trustedIssuers: string[] | undefined,
): string {
  const accepted = eligible.find((issuer) =>
    isProtocolAccepted(issuer.id, trustedIssuers),
  );
  return (accepted ?? eligible[0])?.id ?? "";
}
