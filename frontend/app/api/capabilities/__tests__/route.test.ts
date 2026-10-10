// @vitest-environment node
//
// Coverage for GET /api/capabilities (issue #639) — the machine-readable
// capability descriptor.
//
// lib/env.ts and lib/stellar.ts read process.env at *import* time, so every
// test that needs different env resets the module registry and re-imports
// fresh via loadRoute(). lib/contract-versions and lib/issuer-registry are
// mocked so no RPC happens.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fetchOnChainContractVersion, fetchRegisteredIssuers } = vi.hoisted(() => ({
  fetchOnChainContractVersion: vi.fn(),
  fetchRegisteredIssuers: vi.fn(),
}));

vi.mock("../../../../lib/contract-versions", () => ({
  decodeContractVersion: (n: number) =>
    `${Math.floor(n / 1_000_000)}.${Math.floor((n % 1_000_000) / 1_000)}.${n % 1_000}`,
  fetchOnChainContractVersion,
}));

vi.mock("../../../../lib/issuer-registry", () => ({ fetchRegisteredIssuers }));

const ENV_KEYS = [
  "NEXT_PUBLIC_ISSUER_REGISTRY_ID",
  "NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID",
  "NEXT_PUBLIC_PROOF_REGISTRY_ID",
  "NEXT_PUBLIC_GATED_POOL_ID",
  "NEXT_PUBLIC_ISSUER_ADDRESS",
  "NEXT_PUBLIC_INDEXER_URL",
  "NEXT_PUBLIC_SPONSOR_ACCOUNT_ID",
  "SPONSOR_SECRET",
  "NEXT_PUBLIC_APP_VERSION",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
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

async function loadRoute() {
  vi.resetModules();
  return import("../route");
}

const IDS = {
  issuer_registry: "CISSUER0000000000000000000000000000000000000000000000001",
  credential_verifier: "CVERIFIER0000000000000000000000000000000000000000000001",
  proof_registry: "CPROOF0000000000000000000000000000000000000000000000001",
  gated_pool: "CPOOL00000000000000000000000000000000000000000000000001",
};

describe("GET /api/capabilities", () => {
  it("returns 200 with a public Cache-Control header", async () => {
    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=600",
    );
  });

  it("reports a fully-degraded descriptor when nothing is configured", async () => {
    const { GET } = await loadRoute();
    const res = await GET();
    const body = await res.json();

    expect(body.descriptor_version).toBe(1);
    expect(body.network.id).toBe("testnet");
    expect(body.network.passphrase).toBe("Test SDF Network ; September 2015");
    expect(body.contracts).toEqual({
      issuer_registry: null,
      credential_verifier: null,
      proof_registry: null,
      gated_pool: null,
    });
    expect(body.credential_types).toEqual([
      "kyc",
      "age",
      "jurisdiction",
      "income",
      "funds",
      "accreditation",
      "employment",
    ]);
    expect(body.issuers).toBeNull();
    expect(body.indexer).toBeNull();
    expect(body.sponsored_submission).toEqual({ available: false });
    expect(body.sdk).toEqual({ package: "@stellarcred/sdk", version_range: ">=0.1.1 <1" });
    expect(fetchOnChainContractVersion).not.toHaveBeenCalled();
    expect(fetchRegisteredIssuers).not.toHaveBeenCalled();
  });

  it("lists configured contracts with on-chain versions and an issuer summary", async () => {
    process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID = IDS.issuer_registry;
    process.env.NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID = IDS.credential_verifier;
    process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID = IDS.proof_registry;
    process.env.NEXT_PUBLIC_GATED_POOL_ID = IDS.gated_pool;
    fetchRegisteredIssuers.mockResolvedValue([
      { credentialTypes: ["kyc", "age"] },
      { credentialTypes: ["kyc", "employment"] },
    ]);

    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(body.contracts).toEqual({
      issuer_registry: { id: IDS.issuer_registry, version: "1.1.0" },
      credential_verifier: { id: IDS.credential_verifier, version: "1.1.0" },
      proof_registry: { id: IDS.proof_registry, version: "1.1.0" },
      gated_pool: { id: IDS.gated_pool, version: "1.1.0" },
    });
    // Union of issuer-served types, in platform order.
    expect(body.issuers).toEqual({
      count: 2,
      credential_types: ["kyc", "age", "employment"],
    });
    expect(fetchOnChainContractVersion).toHaveBeenCalledTimes(4);
    expect(fetchRegisteredIssuers).toHaveBeenCalledWith(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
  });

  it("keeps null (unknown) versions when the chain is unreachable", async () => {
    process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID = IDS.proof_registry;
    fetchOnChainContractVersion.mockResolvedValue(null);

    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(body.contracts.proof_registry).toEqual({ id: IDS.proof_registry, version: null });
  });

  it("reports issuers as unknown (null) when the registry call fails", async () => {
    process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID = IDS.issuer_registry;
    fetchRegisteredIssuers.mockRejectedValue(new Error("RPC down"));

    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(body.issuers).toBeNull();
  });

  it("includes the indexer URL only when NEXT_PUBLIC_INDEXER_URL is set", async () => {
    process.env.NEXT_PUBLIC_INDEXER_URL = "https://indexer.example";

    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(body.indexer).toEqual({ url: "https://indexer.example" });
  });

  it("reports sponsored submission only when account AND secret are set", async () => {
    process.env.NEXT_PUBLIC_SPONSOR_ACCOUNT_ID = "GSPONSOR000000000000000000000000000000000000000000000000";
    const { GET } = await loadRoute();
    expect((await (await GET()).json()).sponsored_submission).toEqual({ available: false });

    process.env.SPONSOR_SECRET = "S".repeat(64);
    const { GET: GET2 } = await loadRoute();
    expect((await (await GET2()).json()).sponsored_submission).toEqual({ available: true });
  });
});
