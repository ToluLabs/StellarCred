// Central Stellar/Soroban configuration and contract IDs.
// IDs are read from NEXT_PUBLIC_* env vars populated by scripts/deploy.sh.
//
// Single network selector (Issue #408): NEXT_PUBLIC_STELLAR_NETWORK
// (testnet | mainnet | futurenet) picks a coherent preset for RPC URL,
// network passphrase, and explorer URLs. Explicit NEXT_PUBLIC_RPC_URL /
// NEXT_PUBLIC_NETWORK_PASSPHRASE override the preset; the mixed-config
// preflight in lib/network-check.ts fails loudly when an override belongs
// to a different network than the selector.

export type StellarNetwork = "testnet" | "mainnet" | "futurenet";

interface NetworkPreset {
  rpcUrl: string;
  networkPassphrase: string;
  explorerNetwork: string;
}

// Literal strings, NOT `Networks.TESTNET` from @stellar/stellar-sdk: importing
// the SDK here pulls it into every module that imports this file (including
// SSR), which breaks the build. The values are identical.
export const NETWORK_PRESETS: Record<StellarNetwork, NetworkPreset> = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerNetwork: "testnet",
  },
  mainnet: {
    rpcUrl: "https://soroban.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    explorerNetwork: "mainnet",
  },
  futurenet: {
    rpcUrl: "https://soroban-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
    explorerNetwork: "futurenet",
  },
};

export function parseNetwork(raw: string | undefined): StellarNetwork | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (key === "public" || key === "main") return "mainnet";
  if (key === "testnet" || key === "mainnet" || key === "futurenet") return key;
  return null;
}

const rawNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet";
export const NETWORK: StellarNetwork = parseNetwork(rawNetwork) ?? "testnet";

const preset = NETWORK_PRESETS[NETWORK];

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? preset.rpcUrl;
export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? preset.networkPassphrase;

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
  "employment",
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const EXPLORER_TX = (hash: string) =>
  `https://stellar.expert/explorer/${NETWORK}/tx/${hash}`;

// ── Sponsored / gasless submission ─────────────────────────────────────────
// When set, the holder page offers "Submit without XLM" — the server-side
// relay wraps the holder's signed transaction in a fee-bump paid by this
// account. The holder still authorises the proof; the sponsor only covers
// the network fee.
export const SPONSOR_ACCOUNT_ID =
  process.env.NEXT_PUBLIC_SPONSOR_ACCOUNT_ID ?? "";

// Server-only: the sponsor's secret key.  Never prefixed NEXT_PUBLIC_.
// Read at runtime by app/api/sponsor/route.ts.
// export const SPONSOR_SECRET = process.env.SPONSOR_SECRET ?? "";
