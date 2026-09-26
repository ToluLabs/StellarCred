import {
  NETWORK_PRESETS,
  checkNetworkConsistency,
  parseNetwork,
} from "./networks";

describe("parseNetwork", () => {
  it("parses the three canonical networks", () => {
    expect(parseNetwork("testnet")).toBe("testnet");
    expect(parseNetwork("mainnet")).toBe("mainnet");
    expect(parseNetwork("futurenet")).toBe("futurenet");
  });

  it("accepts mainnet aliases", () => {
    expect(parseNetwork("public")).toBe("mainnet");
    expect(parseNetwork("main")).toBe("mainnet");
  });

  it("is case-insensitive and trims", () => {
    expect(parseNetwork("  MainNet ")).toBe("mainnet");
  });

  it("returns null for unknown or empty values", () => {
    expect(parseNetwork("devnet")).toBeNull();
    expect(parseNetwork("")).toBeNull();
    expect(parseNetwork(undefined)).toBeNull();
  });
});

describe("checkNetworkConsistency", () => {
  it("passes with no overrides", () => {
    const problems = checkNetworkConsistency({ preset: NETWORK_PRESETS.testnet });
    expect(problems).toEqual([]);
  });

  it("passes when overrides match the preset", () => {
    const preset = NETWORK_PRESETS.testnet;
    const problems = checkNetworkConsistency({
      preset,
      horizonUrl: preset.horizonUrl,
      rpcUrl: preset.rpcUrl,
      networkPassphrase: preset.networkPassphrase,
    });
    expect(problems).toEqual([]);
  });

  it("flags a mainnet passphrase with the testnet selector", () => {
    const problems = checkNetworkConsistency({
      preset: NETWORK_PRESETS.testnet,
      networkPassphrase: NETWORK_PRESETS.mainnet.networkPassphrase,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/belongs to mainnet/);
  });

  it("flags a testnet RPC URL with the mainnet selector", () => {
    const problems = checkNetworkConsistency({
      preset: NETWORK_PRESETS.mainnet,
      rpcUrl: NETWORK_PRESETS.testnet.rpcUrl,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/RPC_URL/);
    expect(problems[0]).toMatch(/belongs to testnet/);
  });

  it("flags a testnet horizon URL with the mainnet selector", () => {
    const problems = checkNetworkConsistency({
      preset: NETWORK_PRESETS.mainnet,
      horizonUrl: NETWORK_PRESETS.testnet.horizonUrl,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/HORIZON_URL/);
  });

  it("flags an unknown passphrase", () => {
    const problems = checkNetworkConsistency({
      preset: NETWORK_PRESETS.testnet,
      networkPassphrase: "Some Custom Network ; January 2024",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not match any known network passphrase/);
  });

  it("reports multiple problems together", () => {
    const problems = checkNetworkConsistency({
      preset: NETWORK_PRESETS.mainnet,
      rpcUrl: NETWORK_PRESETS.testnet.rpcUrl,
      networkPassphrase: NETWORK_PRESETS.futurenet.networkPassphrase,
    });
    expect(problems).toHaveLength(2);
  });

  it("accepts a custom (non-preset) URL without flagging it", () => {
    const problems = checkNetworkConsistency({
      preset: NETWORK_PRESETS.testnet,
      rpcUrl: "https://my-own-rpc.example.org",
    });
    expect(problems).toEqual([]);
  });
});
