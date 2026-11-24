// Mixed-network config preflight (Issue #408).
//
// Fails loudly when the effective frontend config mixes artifacts from
// different networks — e.g. a mainnet passphrase with a testnet RPC URL.
// The app and the indexer share the same rule: one network selector must
// drive a coherent config.

import {
  NETWORK,
  NETWORK_PASSPHRASE,
  NETWORK_PRESETS,
  RPC_URL,
} from "./stellar";

export interface NetworkProblem {
  /** Config key at fault, e.g. "NEXT_PUBLIC_NETWORK_PASSPHRASE". */
  key: string;
  /** Human-readable explanation of the mismatch. */
  message: string;
}

function ownerOfPassphrase(passphrase: string): string | null {
  for (const [name, preset] of Object.entries(NETWORK_PRESETS)) {
    if (preset.networkPassphrase === passphrase) return name;
  }
  return null;
}

function ownerOfUrl(url: string): string | null {
  for (const [name, preset] of Object.entries(NETWORK_PRESETS)) {
    if (preset.rpcUrl === url) return name;
  }
  return null;
}

/**
 * Check the effective frontend config for cross-network mixing.
 * Returns a list of problems; empty list means the config is coherent.
 *
 * Checks:
 *  - NETWORK_PASSPHRASE matches the selected network's preset passphrase
 *  - RPC_URL matches the selected network's preset RPC endpoint
 */
export function checkNetworkConfig(): NetworkProblem[] {
  const problems: NetworkProblem[] = [];

  const passOwner = ownerOfPassphrase(NETWORK_PASSPHRASE);
  if (passOwner && passOwner !== NETWORK) {
    problems.push({
      key: "NEXT_PUBLIC_NETWORK_PASSPHRASE",
      message: `Network passphrase belongs to ${passOwner} but NEXT_PUBLIC_STELLAR_NETWORK is ${NETWORK}.`,
    });
  } else if (!passOwner) {
    problems.push({
      key: "NEXT_PUBLIC_NETWORK_PASSPHRASE",
      message: `Network passphrase matches no known network (NEXT_PUBLIC_STELLAR_NETWORK=${NETWORK}).`,
    });
  }

  const rpcOwner = ownerOfUrl(RPC_URL);
  if (rpcOwner && rpcOwner !== NETWORK) {
    problems.push({
      key: "NEXT_PUBLIC_RPC_URL",
      message: `RPC URL belongs to ${rpcOwner} but NEXT_PUBLIC_STELLAR_NETWORK is ${NETWORK}.`,
    });
  }

  return problems;
}
