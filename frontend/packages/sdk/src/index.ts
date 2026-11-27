// @stellarcred/sdk — read-only client for protocols integrating StellarCred.
// The on-chain ProofRegistry is the default source of truth; the optional
// indexer fast path trusts its operator and must not be the sole basis for a
// security decision. See the SDK README for setup and trust-model details.

export * from "./claims";
export * from "./issuers"; // IssuerRegistry reads
export * from "./capabilities";
export * from "./challenge";
export * from "./uniqueness";
export { createClaimGate } from "./core";
export type { ClaimGateConfig, ClaimGateState, ClaimGateListener, ClaimGate } from "./core";
export { useStellarCred } from "./react";
export type { UseStellarCredResult } from "./react";
export * from "./version";
export * from "./wasm";

import {
  configure,
  healthCheck,
  isConfigured,
  hasClaim,
  getClaim,
  getClaimRecord,
  checkClaimStatus,
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

import {
  bootstrap,
  fetchCapabilities,
  validateCapabilitiesDescriptor,
} from "./capabilities";

import {
  createWalletChallenge,
  verifyWalletSignature,
  verifyWalletClaim,
} from "./challenge";
import {
  canonicalizeUniquenessPayload,
  createUniquenessAttestation,
  sameUniquenessSubject,
} from "./uniqueness";

import { subscribeClaims } from "./subscriptions";

import {
  validateCredential,
  parseCredentialJson,
  assertValidCredential,
  CredentialValidationError,
} from "./validateCredential";

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
  submitTransaction,
  validateCredential,
  parseCredentialJson,
  assertValidCredential,
  subscribeClaims,
  createWalletChallenge,
  verifyWalletSignature,
  verifyWalletClaim,
  canonicalizeUniquenessPayload,
  createUniquenessAttestation,
  sameUniquenessSubject,
  CLAIM_TYPES,
  deriveNullifier,
  isNullifierUsed,
  verifyUniquePersonhood,
  TimeoutError,
  ConfigError,
  InvalidAddressError,
  RpcError,
  IndexerError,
  ContractError,
  ContractErrorCode,
  TransactionSubmissionError,
  CredentialValidationError,
  parseContractError,
};
export default StellarCred;
