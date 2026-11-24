 feat/1064-telemetry-opt-in-sanitization
// @stellarcred/sdk
//
// A tiny, zero-dependency* read-only client for protocols integrating
// StellarCred. By default the only thing a protocol trusts is the on-chain
// ProofRegistry — there is no API key, no backend, and no personal data
// handling. `hasClaim` is the primary integration call.
// Reads can optionally be sourced from a StellarCred indexer instead
// (`{ source: "indexer" }`), which is much faster but trusts whoever operates
// that indexer. It is off by default and must never be the sole basis for a
// security decision. See the SDK README §Indexer fast path (issue #613).
// *Requires @stellar/stellar-sdk as a peer dependency.
//
// Quick start and every configuration option: see README.md.

// @stellarcred/sdk — read-only client for protocols integrating StellarCred.
// The on-chain ProofRegistry is the default source of truth; the optional
// indexer fast path (`{ source: "indexer" }`, #613) trusts its operator and
// must never be the sole basis for a security decision. See the SDK README
// for quick start, configuration and env vars. Peer dep: @stellar/stellar-sdk.
  main

export * from "./claims";
export * from "./issuers"; // IssuerRegistry reads
export * from "./capabilities";
export * from "./challenge";
export * from "./presentation-token"; // Server-side presentation tokens (#1062)
export * from "./subscriptions";
export * from "./errors"; // Typed error taxonomy (#404)
export * from "./telemetry"; // Opt-in, zero-PII telemetry (#1064)
export * from "./validateCredential"; // Credential JSON validation (#27)
export * from "./buildVerifyUrl";
export { submitTransaction } from "./submit"; // Transaction submission with retry (#744)
export type { SubmitTransactionOptions } from "./submit";
export { createClaimGate } from "./core";
export type { ClaimGateConfig, ClaimGateState, ClaimGateListener, ClaimGate } from "./core";
export { useStellarCred } from "./react";
export type { UseStellarCredResult } from "./react";

import {
  configure,
  healthCheck,
  isConfigured,
  hasClaim,
  getClaim,
  getClaimRecord,
  checkClaimStatus,
  getClaimOutcome,
 feat/979-typed-claim-read-outcomes

  checkClaimOutcome,
 main
  hasClaims,
  getClaims,
  verifyPreset,
  buildVerifyUrl,
  buildBadgeUrl,
  buildBadgeEmbedCode,
  parseReturnParams,
  watchClaim,
  withRetry,
  normalizeRpcError,
  classifyTransientFailure,
  CLAIM_TYPES,
  deriveNullifier,
  isNullifierUsed,
  verifyUniquePersonhood,
  invalidateClaimCache,
  clearClaimCache,
  TimeoutError,
  ConfigError,
  InvalidAddressError,
} from "./claims";
import {
  RpcError,
  IndexerError,
  ContractError,
  ContractErrorCode,
  parseContractError,
  TransactionSubmissionError,
} from "./errors";
import { submitTransaction } from "./submit";
import { bootstrap, fetchCapabilities, validateCapabilitiesDescriptor } from "./capabilities";
import { createWalletChallenge, verifyWalletSignature, verifyWalletClaim } from "./challenge";
import { createPresentationToken, verifyPresentationToken } from "./presentation-token";
import { subscribeClaims } from "./subscriptions";

// Version helpers — Issue #841
export * from "./version";

import {
  getCredentialCircuitVersion,
  isCompatibleCredential,
  getCredentialVersionStatus,
  getDeploymentCircuitVersion,
  KNOWN_CIRCUIT_VERSIONS,
} from "./version";

import {
  validateCredential,
  parseCredentialJson,
  assertValidCredential,
  CredentialValidationError,
} from "./validateCredential";
import { getIssuer, isValidIssuer, listIssuerIds, listIssuers } from "./issuers";
import { telemetry } from "./telemetry";

export const StellarCred = {
  configure,
  bootstrap,
  fetchCapabilities,
  validateCapabilitiesDescriptor,
  healthCheck,
  isConfigured,
  hasClaim,
  getClaim,
  getClaimRecord,
  checkClaimStatus,
  getClaimOutcome,
 feat/979-typed-claim-read-outcomes

  checkClaimOutcome,
 main
  hasClaims,
  getClaims,
  verifyPreset,
  buildVerifyUrl,
  buildBadgeUrl,
  buildBadgeEmbedCode,
  parseReturnParams,
  watchClaim,
  /** Drop cached claim reads for a wallet (see `configure({ claimCache })`). */
  invalidate: invalidateClaimCache,
  invalidateClaimCache,
  clearClaimCache,
  withRetry,
  normalizeRpcError,
  classifyTransientFailure,
  submitTransaction,
  validateCredential,
  parseCredentialJson,
  assertValidCredential,
  subscribeClaims,
  listIssuers,
  listIssuerIds,
  getIssuer,
  isValidIssuer,
  createWalletChallenge,
  verifyWalletSignature,
  verifyWalletClaim,
  createPresentationToken,
  verifyPresentationToken,
  CLAIM_TYPES,
  deriveNullifier,
  isNullifierUsed,
  verifyUniquePersonhood,
  TimeoutError,
  ConfigError,
  InvalidAddressError,
  RpcError,
  // Version helpers (#841)
  getCredentialCircuitVersion,
  isCompatibleCredential,
  getCredentialVersionStatus,
  getDeploymentCircuitVersion,
  KNOWN_CIRCUIT_VERSIONS,
  IndexerError,
  ContractError,
  ContractErrorCode,
  TransactionSubmissionError,
  CredentialValidationError,
  parseContractError,
  telemetry, // Opt-in, zero-PII telemetry (#1064)
};
export default StellarCred;
