// @stellarcred/sdk — read-only client for protocols integrating StellarCred.
// The on-chain ProofRegistry is the default source of truth; the optional
// indexer fast path trusts its operator and must not be the sole basis for a
// security decision. See the SDK README for setup and trust-model details.

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
export * from "./key-derivation"; // BIP-39 / SEP-5 key derivation (#1068)
export * from "./offline"; // Air-gapped presentation verification (#1059)
export { submitTransaction } from "./submit"; // Transaction submission with retry (#744)
export type { SubmitTransactionOptions } from "./submit";
export { createClaimGate } from "./core";
export type { ClaimGateConfig, ClaimGateState, ClaimGateListener, ClaimGate } from "./core";
export { useStellarCred } from "./react";
export type { UseStellarCredResult } from "./react";
export * from "./wasm";

 feat/universal-wasm-packaging
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
  invalidateClaimCache,
  clearClaimCache,
  TimeoutError,
  ConfigError,
  InvalidAddressError,
} from "./claims";
import {
  RpcError, IndexerError, ContractError, ContractErrorCode, parseContractError, TransactionSubmissionError,
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
import {
  clearWasmCache,
  compileWasm,
  detectWasmRuntime,
  getWasmCacheSize,
  initWasm,
  isStreamingSupported,
  isWasmSupported,
  WasmLoadError,
} from "./wasm";

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
  // Universal WASM helpers
  initWasm,
  compileWasm,
  detectWasmRuntime,
  isWasmSupported,
  isStreamingSupported,
  clearWasmCache,
  getWasmCacheSize,
  WasmLoadError,
};
export default StellarCred;

// The `StellarCred` namespace object lives in its own module so this entry
// point stays a lean barrel; it is re-exported (with `default`) from here.
export { StellarCred, default } from "./namespace";
 main
