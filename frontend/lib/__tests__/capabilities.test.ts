// @vitest-environment node
//
// Unit tests for the capability descriptor builder (issue #639).
// The route-level behaviour (headers, env gating) is covered in
// app/api/capabilities/__tests__/route.test.ts; this file focuses on the
// issuer-summary union and degraded paths with mocked RPC helpers.
//
// lib/stellar.ts reads contract IDs at import time, so each test sets env
// and re-imports fresh via loadModule().

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fetchOnChainContractVersion, fetchRegisteredIssuers } = vi.hoisted(() => ({
  fetchOnChainContractVersion: vi.fn(),
  fetchRegisteredIssuers: vi.fn(),
}));

vi.mock("../contract-versions", () => ({
  decodeContractVersion: (n: number) =>
    `${Math.floor(n / 1_000_000)}.${Math.floor((n % 1_000_000) / 1_000)}.${n % 1_000}`,
  fetchOnChainContractVersion,
}));

vi.mock("../issuer-registry", () => ({ fetchRegisteredIssuers }));

const ENV_KEYS = ["NEXT_PUBLIC_ISSUER_REGISTRY_ID", "NEXT_PUBLIC_ISSUER_ADDRESS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID =
    "CISSUER0000000000000000000000000000000000000000000000001";
  fetchOnChainContractVersion.mockResolvedValue("1.1.0");
  fetchRegisteredIssuers.mockResolvedValue([]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  return import("../capabilities");
}

describe("buildCapabilitiesDescriptor", () => {
  it("carries the descriptor version and SDK compatibility range", async () => {
    const { buildCapabilitiesDescriptor, CAPABILITIES_DESCRIPTOR_VERSION } = await loadModule();
    const descriptor = await buildCapabilitiesDescriptor();

    expect(descriptor.descriptor_version).toBe(CAPABILITIES_DESCRIPTOR_VERSION);
    expect(descriptor.sdk.package).toBe("@stellarcred/sdk");
    expect(descriptor.sdk.version_range).toMatch(/^>=/);
  });

  it("derives the issuer summary as an ordered union of served types", async () => {
    fetchRegisteredIssuers.mockResolvedValue([
      { credentialTypes: ["funds", "kyc"] },
      { credentialTypes: ["age"] },
      { credentialTypes: [] },
    ]);

    const { buildCapabilitiesDescriptor } = await loadModule();
    const descriptor = await buildCapabilitiesDescriptor();

    expect(descriptor.issuers).toEqual({
      count: 3,
      // Platform order (CREDENTIAL_TYPES), not insertion order.
      credential_types: ["kyc", "age", "funds"],
    });
  });

  it("ignores unknown credential types served by issuers", async () => {
    fetchRegisteredIssuers.mockResolvedValue([{ credentialTypes: ["kyc", "mystery"] }]);

    const { buildCapabilitiesDescriptor } = await loadModule();
    const descriptor = await buildCapabilitiesDescriptor();

    expect(descriptor.issuers?.credential_types).toEqual(["kyc"]);
  });

  it("reports issuers as unknown when the registry call fails", async () => {
    fetchRegisteredIssuers.mockRejectedValue(new Error("RPC down"));

    const { buildCapabilitiesDescriptor } = await loadModule();
    const descriptor = await buildCapabilitiesDescriptor();

    expect(descriptor.issuers).toBeNull();
  });
});
