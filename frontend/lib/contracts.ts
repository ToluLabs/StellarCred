"use client";

// Public surface of the StellarCred client-side contract layer.
//
// This barrel re-exports every symbol that was previously defined in this
// file so that all existing import paths (`@/lib/contracts`) continue to
// work unchanged. The implementation is now split across three focused
// modules:
//
//   contract-errors.ts       — error taxonomy, ContractError type,
//                              parseContractError, fee estimation helpers
//                              (STROOPS_PER_XLM, formatFeeXlm, FeeEstimate,
//                              PreflightResult, normalizeSimulationError,
//                              evaluateSimulation)
//   contract-simulation.ts   — preflight / read-only queries
//                              (VerificationStatus, checkClaim, isVerified)
//   contract-transactions.ts — tx construction, signing, submission, polling,
//                              and preflight simulations
//                              (ProofSubmissionParams, MAX_BATCH_SIZE,
//                              preflightSubmitProof, preflightSubmitProofs,
//                              submitProof, submitProofs, submitAggregateProof)

// ── contract-errors ───────────────────────────────────────────────────────────
export { PROOF_REGISTRY_ERRORS, parseContractError } from "./contract-errors";
export type { ContractError, FeeEstimate, PreflightResult } from "./contract-errors";
export {
  STROOPS_PER_XLM,
  formatFeeXlm,
  normalizeSimulationError,
  evaluateSimulation,
} from "./contract-errors";

// ── contract-simulation ───────────────────────────────────────────────────────
export type { VerificationStatus } from "./contract-simulation";
export { checkClaim, isVerified } from "./contract-simulation";

// ── contract-transactions ─────────────────────────────────────────────────────
export type { ProofSubmissionParams } from "./contract-transactions";
export {
  MAX_BATCH_SIZE,
  preflightSubmitProof,
  preflightSubmitProofs,
  submitProof,
  submitProofs,
  submitAggregateProof,
} from "./contract-transactions";
