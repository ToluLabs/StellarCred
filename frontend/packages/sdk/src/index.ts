// @stellarcred/sdk
//
// A tiny, zero-dependency* read-only client for protocols integrating
// StellarCred. By default the only thing a protocol trusts is the on-chain
// ProofRegistry — there is no API key, no backend, and no personal data
// handling. `hasClaim` is the primary integration call.
//
// Reads can optionally be sourced from a StellarCred indexer instead
// (`{ source: "indexer" }`), which is much faster but trusts whoever operates
// that indexer. It is off by default and must never be the sole basis for a
// security decision. See the SDK README §Indexer fast path (issue #613).
//
// *Requires @stellar/stellar-sdk as a peer dependency.
//
// Quick start (Next.js / Vite / Node.js):
//
//   import StellarCred from "@stellarcred/sdk";
//
//   // Option A: configure explicitly at startup (recommended for servers)
//   StellarCred.configure({
//     registryId: process.env.PROOF_REGISTRY_ID,
//     rpcUrl: "https://soroban-testnet.stellar.org",
//   });
//
//   // Option B: set env vars instead (STELLARCRED_REGISTRY_ID, etc.)
//   //           — works in both Node.js and Next.js (NEXT_PUBLIC_* prefix)
//
//   const ok = await StellarCred.hasClaim(walletAddress, "kyc");

export * from "./claims";
export * from "./capabilities";
export * from "./challenge";
export * from "./subscriptions";
export * from "./errors"; // Typed error taxonomy (#404)
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
  hasClaims,
  getClaims,
  verifyPreset,
  buildVerifyUrl,
  buildBadgeUrl,
  buildBadgeEmbedCode,
  parseReturnParams,
  watchClaim,
  withRetry,
  CLAIM_TYPES,
  TimeoutError,
  ConfigError,
  InvalidAddressError,
} from "./claims";

import { RpcError, IndexerError, ContractError, ContractErrorCode, parseContractError } from "./errors";

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

import { subscribeClaims } from "./subscriptions";

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
  subscribeClaims,
  createWalletChallenge,
  verifyWalletSignature,
  verifyWalletClaim,
  CLAIM_TYPES,
  TimeoutError,
  ConfigError,
  InvalidAddressError,
  RpcError,
  IndexerError,
  ContractError,
  ContractErrorCode,
  parseContractError,
};
export default StellarCred;
