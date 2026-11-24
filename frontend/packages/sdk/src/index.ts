// @stellarcred/sdk — read-only client for protocols integrating StellarCred.
// The on-chain ProofRegistry is the default source of truth; the optional
// indexer fast path (#613) trusts its operator and is never the sole basis for
// a security decision. Quick start, configuration and supported runtimes:
// see README.md and docs/SDK_RUNTIME_SUPPORT.md. Peer dep: @stellar/stellar-sdk.

export * from "./claims";
export * from "./issuers"; // IssuerRegistry reads
export * from "./capabilities";
export * from "./challenge";
export * from "./subscriptions";
export * from "./errors"; // Typed error taxonomy (#404)
export * from "./telemetry"; // Opt-in, zero-PII telemetry (#1064)
export * from "./validateCredential"; // Credential JSON validation (#27)
export * from "./buildVerifyUrl";
export { submitTransaction, type SubmitTransactionOptions } from "./submit"; // Retry (#744)
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
  checkClaimOutcome,
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
  checkClaimOutcome,
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
