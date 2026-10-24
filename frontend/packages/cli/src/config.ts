import { NETWORK_PRESETS, type StellarNetwork } from "@stellarcred/sdk";

/**
 * Contract ids used when nothing is configured, per network. Testnet values
 * come from DEPLOYMENTS.md (the authoritative registry); mainnet has none yet,
 * so mainnet always needs explicit ids.
 */
export const DEFAULT_CONTRACTS: Record<
  StellarNetwork,
  { proofRegistry?: string; issuerRegistry?: string }
> = {
  testnet: {
    proofRegistry: "CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV",
    issuerRegistry: "CDYPCHIFRXAAJFUA7MBH4FAWYLNG7XMAH7QRGVF437V2PGDBXZ2VK2DZ",
  },
  mainnet: {},
  futurenet: {},
};

export interface CliConfig {
  network: StellarNetwork;
  rpcUrl: string;
  networkPassphrase: string;
  registryId: string;
  issuerRegistryId: string;
  baseUrl: string;
}

export type Env = Record<string, string | undefined>;
export type Flags = Record<string, string | boolean | string[] | undefined>;

const first = (...values: Array<string | boolean | string[] | undefined>): string | undefined => {
  for (const v of values) if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
};

export function parseNetwork(raw: string | undefined): StellarNetwork {
  const key = (raw ?? "testnet").trim().toLowerCase();
  if (key === "public" || key === "main") return "mainnet";
  if (key === "testnet" || key === "mainnet" || key === "futurenet") return key;
  throw new Error(`Unknown network "${raw}". Use testnet, mainnet or futurenet.`);
}

/**
 * Flags win over environment variables, which win over network defaults. The
 * environment variable names are the SDK's own (STELLARCRED_*), plus the
 * server-side names the app uses (PROOF_REGISTRY_ID), so a CI job or server
 * that already configures the SDK configures the CLI too.
 */
export function resolveConfig(flags: Flags, env: Env): CliConfig {
  const network = parseNetwork(first(flags.network, env.STELLARCRED_NETWORK));
  const preset = NETWORK_PRESETS[network];
  const defaults = DEFAULT_CONTRACTS[network];
  return {
    network,
    rpcUrl: first(flags["rpc-url"], env.STELLARCRED_RPC_URL) ?? preset.rpcUrl,
    networkPassphrase: first(env.STELLARCRED_NETWORK_PASSPHRASE) ?? preset.networkPassphrase,
    registryId:
      first(flags["registry-id"], env.STELLARCRED_REGISTRY_ID, env.PROOF_REGISTRY_ID) ??
      defaults.proofRegistry ??
      "",
    issuerRegistryId:
      first(flags["issuer-registry-id"], env.STELLARCRED_ISSUER_REGISTRY_ID) ??
      defaults.issuerRegistry ??
      "",
    baseUrl: first(flags["base-url"], env.STELLARCRED_BASE_URL) ?? "https://stellarcred.xyz",
  };
}
