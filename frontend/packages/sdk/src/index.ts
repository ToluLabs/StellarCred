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
// Quick start and every configuration option: see README.md.
// @stellarcred/sdk — read-only client for protocols integrating StellarCred.
// The on-chain ProofRegistry is the default source of truth; the optional
// indexer fast path trusts its operator and must not be the sole basis for a
// security decision. See the SDK README for setup and trust-model details.

export * from "./claims";
export * from "./issuers";
export * from "./capabilities";
export * from "./challenge";
export * from "./presentation-token"; // Server-side presentation tokens (#1062)
export * from "./subscriptions";
export * from "./errors";
export * from "./telemetry";
export * from "./validateCredential";
export * from "./buildVerifyUrl";
export * from "./offline"; // Air-gapped presentation verification (#1059)
export { submitTransaction } from "./submit"; // Transaction submission with retry (#744)
export type { SubmitTransactionOptions } from "./submit";
export { createClaimGate } from "./core";
export type { ClaimGateConfig, ClaimGateState, ClaimGateListener, ClaimGate } from "./core";
export { useStellarCred } from "./react";
export type { UseStellarCredResult } from "./react";

// Version helpers — Issue #841
export * from "./version";
// The `StellarCred` namespace object lives in its own module so this entry
// point stays a lean barrel; it is re-exported (with `default`) from here.
export { StellarCred, default } from "./namespace";
