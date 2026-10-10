// @vitest-environment node
//
// Unit tests for on-chain contract version decoding (issue #639).
// The RPC path is exercised indirectly via /api/capabilities tests (mocked);
// here we cover the pure u32 → semver encoding documented in the contracts:
// (major * 1_000_000) + (minor * 1_000) + patch.

import { describe, it, expect } from "vitest";

import { decodeContractVersion, fetchOnChainContractVersion } from "../contract-versions";

describe("decodeContractVersion", () => {
  it.each([
    [1_000_000, "1.0.0"],
    [1_001_000, "1.1.0"],
    [1_001_007, "1.1.7"],
    [2_003_021, "2.3.21"],
    [0, "0.0.0"],
    [42, "0.0.42"],
  ])("decodes %i as %s", (encoded, expected) => {
    expect(decodeContractVersion(encoded)).toBe(expected);
  });
});

describe("fetchOnChainContractVersion", () => {
  it("returns null without touching RPC when the contract id is empty", async () => {
    await expect(fetchOnChainContractVersion("", "GAAAA")).resolves.toBeNull();
  });
});
