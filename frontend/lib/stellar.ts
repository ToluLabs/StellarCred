// Central Stellar/Soroban configuration and contract IDs.
// IDs are read from NEXT_PUBLIC_* env vars populated by scripts/deploy.sh.
export const NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet";
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://soroban-testnet.stellar.org";
// Literal string, NOT `Networks.TESTNET` from @stellar/stellar-sdk: importing
// the SDK here pulls it into every module that imports this file (including
// SSR), which breaks the build. The value is identical.
export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";

export const CONTRACTS = {
  issuerRegistry: process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID ?? "",
  credentialVerifier: process.env.NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID ?? "",
  proofRegistry: process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID ?? "",
  gatedPool: process.env.NEXT_PUBLIC_GATED_POOL_ID ?? "",
};

// Credential types, matching the Symbol values used by the contracts.
export const CREDENTIAL_TYPES = [
  "kyc",
  "age",
  "jurisdiction",
  "income",
  "funds",
  "accreditation",
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const EXPLORER_TX = (hash: string) =>
  `https://stellar.expert/explorer/${NETWORK}/tx/${hash}`;
