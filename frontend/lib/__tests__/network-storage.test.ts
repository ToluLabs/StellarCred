import { describe, it, expect, beforeEach } from "vitest";
import { getPreferredNetwork, setPreferredNetwork } from "../network-storage";

describe("network-storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to testnet when nothing is stored", () => {
    expect(getPreferredNetwork()).toBe("testnet");
  });

  it("persists and retrieves preferred network", () => {
    setPreferredNetwork("mainnet");
    expect(getPreferredNetwork()).toBe("mainnet");

    setPreferredNetwork("futurenet");
    expect(getPreferredNetwork()).toBe("futurenet");
  });
});
