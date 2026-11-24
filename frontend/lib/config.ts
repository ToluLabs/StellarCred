// Centralized deploy-configuration checks.
//
// Single source of truth for "is the app configured for X". Consumed by:
//   - components/ConfigBanner.tsx (what the user sees up front)
//   - app/api/ready/route.ts (what ops monitors)
//   - pages that disable actions doomed to fail mid-flight
//
// Client-safe: reads only NEXT_PUBLIC_* vars via lib/stellar.ts literals, so
// Next's build-time inliner sees them. Do NOT import lib/env.ts from here —
// it is server-only and throws in the browser.

import { CONTRACTS, SPONSOR_ACCOUNT_ID } from "./stellar";

type ContractKey = keyof typeof CONTRACTS;

/** Env var name backing each entry of CONTRACTS (lib/stellar.ts). */
export const CONTRACT_ENV_VARS: Record<ContractKey, string> = {
  issuerRegistry: "NEXT_PUBLIC_ISSUER_REGISTRY_ID",
  credentialVerifier: "NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID",
  proofRegistry: "NEXT_PUBLIC_PROOF_REGISTRY_ID",
  gatedPool: "NEXT_PUBLIC_GATED_POOL_ID",
};

export const ISSUER_ADDRESS_ENV_VAR = "NEXT_PUBLIC_ISSUER_ADDRESS";

/**
 * Which contract-ID env vars are missing, as env-var names (stable strings
 * suitable for both UI copy and /api/ready's machine-readable message).
 * Empty array = fully configured. This is exactly what /api/ready's
 * `contracts` check reports, so the banner and readiness probe can never
 * drift apart.
 */
export function missingContractEnvVars(): string[] {
  return Object.entries(CONTRACTS)
    .filter(([, v]) => !v)
    .map(([k]) => CONTRACT_ENV_VARS[k as ContractKey]);
}

export function contractsConfigured(): boolean {
  return missingContractEnvVars().length === 0;
}

/** Whether on-chain proof submission (Holder page) can work at all. */
export function proofSubmissionConfigured(): boolean {
  return Boolean(CONTRACTS.proofRegistry);
}

/**
 * Env vars required before credential issuance (/verify and /issuer) can
 * work: the demo issuer address every issue request is attributed to, plus
 * IssuerRegistry so issuers can be listed and their keys verified. Both come
 * from scripts/deploy.sh like the contract IDs.
 */
export function missingIssueConfigEnvVars(): string[] {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_ISSUER_ADDRESS) missing.push(ISSUER_ADDRESS_ENV_VAR);
  if (!CONTRACTS.issuerRegistry) missing.push(CONTRACT_ENV_VARS.issuerRegistry);
  return missing;
}

export function issuanceConfigured(): boolean {
  return missingIssueConfigEnvVars().length === 0;
}

/** Whether the gasless / sponsored submission relay is configured. */
export function sponsorConfigured(): boolean {
  return Boolean(SPONSOR_ACCOUNT_ID);
}
