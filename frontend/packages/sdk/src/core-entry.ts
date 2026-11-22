// @stellarcred/sdk/core — zero-dependency minimal footprint entry point (#1066)
//
// A stripped-down build target for lightweight serverless and embedded
// environments. It deliberately excludes:
//
//   • UI helpers (badge URLs / embed code, verify-URL builders)
//   • the React hook (`useStellarCred`) and every React import
//   • the framework-agnostic claim gate (`createClaimGate`)
//   • indexer, capabilities, challenge, subscriptions, and transaction
//     submission modules
//
// What remains is the pure, dependency-free core: claim types, the claim
// configuration surface, the typed error taxonomy, and the pure helpers that
// operate on already-fetched data. Nothing in this module imports
// `@stellar/stellar-sdk`, React, or any other runtime package, so bundlers can
// emit a tiny bundle with no external requires.
//
//   import { CLAIM_TYPES, RpcError } from "@stellarcred/sdk/core";
//
// Claim *reads* (which need an RPC client) stay on the full entry point:
//
//   import { hasClaim } from "@stellarcred/sdk";

// ── Claim types & constants ──────────────────────────────────────────────────

export { CLAIM_TYPES } from "./claims";
export type { ClaimType } from "./claims";

// ── Typed error taxonomy (#404) ──────────────────────────────────────────────

export {
  RpcError,
  ContractError,
  ContractErrorCode,
  TransactionSubmissionError,
  parseContractError,
  PROOF_REGISTRY_ERROR_MESSAGES,
} from "./errors";

// IndexerError is defined in the dependency-free indexer module.
export { IndexerError } from "./indexer";

// ── Credential JSON validation (#27) — pure, no network ──────────────────────

export {
  validateCredential,
  parseCredentialJson,
  assertValidCredential,
  CredentialValidationError,
} from "./validateCredential";
export type { CredentialValidationResult } from "./validateCredential";

// ── Circuit version helpers (#841) — pure, no network ────────────────────────

export {
  getCredentialCircuitVersion,
  isCompatibleCredential,
  getCredentialVersionStatus,
  getDeploymentCircuitVersion,
  KNOWN_CIRCUIT_VERSIONS,
} from "./version";
