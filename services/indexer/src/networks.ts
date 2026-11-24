/**
 * networks.ts — Canonical per-network presets for StellarCred.
 *
 * A single selector (`STELLAR_NETWORK` env var, values: testnet | mainnet |
 * futurenet) picks one of these presets, which supplies the Horizon URL,
 * Soroban RPC URL, and network passphrase. Explicit env vars (HORIZON_URL,
 * RPC_URL, NETWORK_PASSPHRASE) override the preset — but when they do, the
 * preflight in config.ts checks them for cross-network mismatches so a
 * "mainnet passphrase with testnet RPC" mistake fails loudly at startup.
 */

export type StellarNetwork = "testnet" | "mainnet" | "futurenet";

export interface NetworkPreset {
  /** Canonical lowercase network name. */
  name: StellarNetwork;
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Stellar.expert explorer base for this network. */
  explorerNetwork: string;
}

export const NETWORK_PRESETS: Record<StellarNetwork, NetworkPreset> = {
  testnet: {
    name: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerNetwork: "testnet",
  },
  mainnet: {
    name: "mainnet",
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: "https://soroban.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    explorerNetwork: "mainnet",
  },
  futurenet: {
    name: "futurenet",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    rpcUrl: "https://soroban-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
    explorerNetwork: "futurenet",
  },
};

/** Parse a network name, returning null for unknown values. */
export function parseNetwork(raw: string | undefined): StellarNetwork | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  // Accept "public"/"main" as aliases for mainnet.
  if (key === "public" || key === "main") return "mainnet";
  if (key === "testnet" || key === "mainnet" || key === "futurenet") return key;
  return null;
}

/**
 * Cross-network consistency check between a chosen preset and any explicit
 * env overrides. Returns a list of human-readable problems (empty = clean).
 * A problem means the effective config mixes artifacts from two networks —
 * e.g. a mainnet passphrase with testnet contract IDs — which must fail
 * loudly instead of silently indexing/signing against the wrong network.
 */
export function checkNetworkConsistency(options: {
  preset: NetworkPreset;
  /** Explicitly provided horizon URL, if any. */
  horizonUrl?: string;
  /** Explicitly provided RPC URL, if any. */
  rpcUrl?: string;
  /** Explicitly provided passphrase, if any. */
  networkPassphrase?: string;
}): string[] {
  const problems: string[] = [];
  const { preset } = options;

  if (options.networkPassphrase && options.networkPassphrase !== preset.networkPassphrase) {
    const owner = Object.values(NETWORK_PRESETS).find(
      (p) => p.networkPassphrase === options.networkPassphrase,
    );
    problems.push(
      owner
        ? `NETWORK_PASSPHRASE belongs to ${owner.name} but STELLAR_NETWORK is ${preset.name}.`
        : `NETWORK_PASSPHRASE does not match any known network passphrase (STELLAR_NETWORK=${preset.name}).`,
    );
  }

  for (const [label, url] of [
    ["HORIZON_URL", options.horizonUrl],
    ["RPC_URL", options.rpcUrl],
  ] as const) {
    if (!url) continue;
    const owner = Object.values(NETWORK_PRESETS).find(
      (p) => p.horizonUrl === url || p.rpcUrl === url,
    );
    if (owner && owner.name !== preset.name) {
      problems.push(
        `${label} (${url}) belongs to ${owner.name} but STELLAR_NETWORK is ${preset.name}.`,
      );
    }
  }

  return problems;
}
