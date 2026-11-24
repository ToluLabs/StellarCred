// @stellarcred/sdk — read-only client for protocols integrating StellarCred.
// The on-chain ProofRegistry is the default source of truth; the optional
// indexer fast path trusts its operator and must not be the sole basis for a
// security decision. See the SDK README for setup and trust-model details.

export * from "./claims";
export * from "./issuers";
export * from "./capabilities";
export * from "./challenge";
export * from "./subscriptions";
export * from "./errors";
export * from "./telemetry";
export * from "./validateCredential";
export * from "./buildVerifyUrl";
export { submitTransaction } from "./submit";
export type { SubmitTransactionOptions } from "./submit";
export { createClaimGate } from "./core";
export type { ClaimGateConfig, ClaimGateState, ClaimGateListener, ClaimGate } from "./core";
export { useStellarCred } from "./react";
export type { UseStellarCredResult } from "./react";
export * from "./version";

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
  telemetry,
};

export default StellarCred;
