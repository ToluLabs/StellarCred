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
export * from "./version";
export * from "./wasm";

// The `StellarCred` namespace object lives in its own module so this entry
// point stays a lean barrel; it is re-exported (with `default`) from here.
export { StellarCred, default } from "./namespace";
