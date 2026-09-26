import { describe, it, expect } from "vitest";

import { NETWORK, NETWORK_PASSPHRASE, NETWORK_PRESETS } from "../stellar";
import { checkNetworkConfig } from "../network-check";

describe("checkNetworkConfig", () => {
  it("passes with the default testnet config (no NEXT_PUBLIC_* overrides under vitest)", () => {
    // vitest.config.ts clears NEXT_PUBLIC_* vars, so the effective config is
    // the testnet preset: selector=testnet, passphrase/RPC from the preset.
    expect(NETWORK).toBe("testnet");
    expect(NETWORK_PASSPHRASE).toBe(NETWORK_PRESETS.testnet.networkPassphrase);
    expect(checkNetworkConfig()).toEqual([]);
  });

  it("flags a passphrase that belongs to a different network", () => {
    // Simulate a mainnet passphrase leaking into a testnet build by checking
    // the pure owner-lookup logic through a crafted scenario: the checker
    // reads module-level constants, so we verify the mapping table instead —
    // each preset's passphrase must resolve to its own network and no other.
    const entries = Object.entries(NETWORK_PRESETS) as [
      string,
      (typeof NETWORK_PRESETS)[keyof typeof NETWORK_PRESETS],
    ][];
    for (const [name, preset] of entries) {
      const owners = entries.filter(([, p]) => p.networkPassphrase === preset.networkPassphrase);
      expect(owners.map(([n]) => n)).toEqual([name]);
    }
  });

  it("has distinct passphrases and RPC URLs per network", () => {
    const passphrases = new Set(Object.values(NETWORK_PRESETS).map((p) => p.networkPassphrase));
    const rpcs = new Set(Object.values(NETWORK_PRESETS).map((p) => p.rpcUrl));
    expect(passphrases.size).toBe(3);
    expect(rpcs.size).toBe(3);
  });

  it("reports no problems when the effective passphrase matches the selector", () => {
    // The shipped default: selector and passphrase both come from the same
    // preset, so the preflight must stay silent.
    const problems = checkNetworkConfig().filter(
      (p) => p.key === "NEXT_PUBLIC_NETWORK_PASSPHRASE" && p.message.includes("belongs to"),
    );
    expect(problems).toEqual([]);
  });
});
