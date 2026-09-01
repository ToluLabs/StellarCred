// Env resolution mirrors @stellarcred/sdk's own `env()` helper: prefer the
// server-side name, fall back to the NEXT_PUBLIC_ variant so a `.env` copied
// straight from a StellarCred frontend deployment works unmodified.

function env(key: string, nextPublicKey?: string): string {
  return (
    process.env[key] ?? (nextPublicKey ? (process.env[nextPublicKey] ?? "") : "")
  );
}

export interface CliConfig {
  rpcUrl: string;
  networkPassphrase: string;
  network: string;
  baseUrl: string;
  proofRegistryId: string;
  issuerRegistryId: string;
  /** Any existing funded account, used as the simulation source for read-only issuer-registry calls. */
  simAccount: string;
}

export function loadConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    rpcUrl:
      overrides.rpcUrl ||
      env("STELLARCRED_RPC_URL", "NEXT_PUBLIC_RPC_URL") ||
      "https://soroban-testnet.stellar.org",
    networkPassphrase:
      overrides.networkPassphrase ||
      env("STELLARCRED_NETWORK_PASSPHRASE", "NEXT_PUBLIC_NETWORK_PASSPHRASE") ||
      "Test SDF Network ; September 2015",
    network: overrides.network || env("STELLARCRED_NETWORK", "NEXT_PUBLIC_STELLAR_NETWORK") || "testnet",
    baseUrl:
      overrides.baseUrl ||
      env("STELLARCRED_BASE_URL", "NEXT_PUBLIC_STELLARCRED_BASE_URL") ||
      "https://stellarcred.xyz",
    proofRegistryId: overrides.proofRegistryId || env("STELLARCRED_REGISTRY_ID", "NEXT_PUBLIC_PROOF_REGISTRY_ID"),
    issuerRegistryId:
      overrides.issuerRegistryId ||
      env("STELLARCRED_ISSUER_REGISTRY_ID", "NEXT_PUBLIC_ISSUER_REGISTRY_ID"),
    simAccount: overrides.simAccount || env("STELLARCRED_SIM_ACCOUNT", "NEXT_PUBLIC_ISSUER_ADDRESS"),
  };
}
