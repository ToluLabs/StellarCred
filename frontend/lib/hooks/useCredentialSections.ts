"use client";

import type { Credential } from "../credential";
import { PREVIEW_CREDENTIALS } from "../preview-fixtures";
import { daysRemaining, isExpiringSoon, proofStatus } from "../proof-helpers";

export function useCredentialSections(creds: Credential[], isPreview: boolean) {
  const displayCreds = isPreview ? PREVIEW_CREDENTIALS : creds;
  const unproved = displayCreds.filter((credential) => proofStatus(credential) === "unproved");
  const expiringSoon = displayCreds
    .filter((credential) => proofStatus(credential) === "proved" && isExpiringSoon(credential, 7))
    .sort((a, b) => daysRemaining(a) - daysRemaining(b));
  const activeProved = displayCreds.filter(
    (credential) => proofStatus(credential) === "proved" && !isExpiringSoon(credential, 7),
  );
  const expired = displayCreds.filter((credential) => proofStatus(credential) === "expired");

  return { displayCreds, unproved, expiringSoon, activeProved, expired };
}