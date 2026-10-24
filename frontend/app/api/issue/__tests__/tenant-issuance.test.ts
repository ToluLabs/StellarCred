// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Tenant } from "@/lib/tenancy";

const HOLDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function be32(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
}

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/issue", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/issue - Tenant-Aware Issuance & Vault Integration", () => {
  const TENANT_A_KEY = "1111111111111111111111111111111111111111111111111111111111111111";
  const TENANT_B_KEY = "2222222222222222222222222222222222222222222222222222222222222222";

  const TENANT_A: Tenant = {
    id: "tenant_alpha",
    name: "Alpha Financial",
    apiKey: "sk_live_alpha_test_key_12345",
    status: "active",
    config: {
      issuerId: "GALPHA000000000000000000000000000000000000000000000000000",
      issuerName: "Alpha Financial Authority",
      signingKeySecretRef: "secret/data/stellarcred/tenants/alpha/signing-key",
      allowedCredentialTypes: ["kyc", "age"],
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const TENANT_B: Tenant = {
    id: "tenant_beta",
    name: "Beta Banking",
    apiKey: "sk_live_beta_test_key_67890",
    status: "active",
    config: {
      issuerId: "GBETA0000000000000000000000000000000000000000000000000000",
      issuerName: "Beta Banking Authority",
      signingKeySecretRef: "secret/data/stellarcred/tenants/beta/signing-key",
      allowedCredentialTypes: ["funds", "income"],
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const SUSPENDED_TENANT: Tenant = {
    id: "tenant_suspended",
    name: "Suspended Tenant",
    apiKey: "sk_live_suspended_key_99999",
    status: "suspended",
    config: {
      issuerId: "GSUSPENDED000000000000000000000000000000000000000000000000",
      issuerName: "Suspended Authority",
      signingKeySecretRef: "secret/suspended",
      allowedCredentialTypes: ["kyc"],
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadRouteWithContext() {
    vi.resetModules();
    const route = await import("../route");
    const { setSecretsProvider, MockSecretsProvider } = await import("@/lib/secrets-vault");
    const { setTenantStore, InMemoryTenantStore } = await import("@/lib/tenancy");

    const mockSecrets = new MockSecretsProvider({
      "secret/data/stellarcred/tenants/alpha/signing-key": TENANT_A_KEY,
      "secret/data/stellarcred/tenants/beta/signing-key": TENANT_B_KEY,
    });
    setSecretsProvider(mockSecrets);

    const mockStore = new InMemoryTenantStore([TENANT_A, TENANT_B, SUSPENDED_TENANT]);
    setTenantStore(mockStore);

    return route;
  }

  it("issues credentials signed with tenant-specific key resolved from Vault secrets provider", async () => {
    const { POST } = await loadRouteWithContext();

    const res = await POST(
      postRequest(
        {
          credential_types: ["age"],
          holder: HOLDER,
          attributes: { date_of_birth: "1990-01-01" },
        },
        {
          "x-api-key": TENANT_A.apiKey,
        },
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials).toHaveLength(1);

    const credential = body.credentials[0];
    expect(credential.issuerId).toBe(TENANT_A.config.issuerId);
    expect(credential.issuer).toBe(TENANT_A.config.issuerName);

    // Verify signature with Tenant A's public key (derived from TENANT_A_KEY)
    const expectedPub = secp256k1.getPublicKey(
      Uint8Array.from(Buffer.from(TENANT_A_KEY, "hex")),
      false,
    );
    expect(credential.issuerPubX).toEqual(Array.from(expectedPub.slice(1, 33)));
    expect(credential.issuerPubY).toEqual(Array.from(expectedPub.slice(33, 65)));

    const pubkey = new Uint8Array([0x04, ...credential.issuerPubX, ...credential.issuerPubY]);
    const digest = be32(BigInt(credential.commitment));
    const sig = Uint8Array.from(credential.sig);
    expect(secp256k1.verify(sig, digest, pubkey, { prehash: false })).toBe(true);
  });

  it("authenticates via Authorization: Bearer <apiKey> header", async () => {
    const { POST } = await loadRouteWithContext();

    const res = await POST(
      postRequest(
        {
          credential_types: ["kyc"],
          holder: HOLDER,
        },
        {
          authorization: `Bearer ${TENANT_A.apiKey}`,
        },
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credentials[0].issuerId).toBe(TENANT_A.config.issuerId);
  });

  it("enforces tenant isolation: rejects Tenant A trying to issue as Tenant B with 403 Forbidden", async () => {
    const { POST } = await loadRouteWithContext();

    const res = await POST(
      postRequest(
        {
          credential_types: ["age"],
          holder: HOLDER,
          attributes: { date_of_birth: "1990-01-01" },
        },
        {
          "x-api-key": TENANT_A.apiKey,
          "x-tenant-id": "tenant_beta", // Mismatched tenant ID!
        },
      ),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Tenant isolation violation/);
  });

  it("enforces tenant isolation: rejects Tenant specifying an unauthorized issuerId in body", async () => {
    const { POST } = await loadRouteWithContext();

    const res = await POST(
      postRequest(
        {
          credential_types: ["age"],
          holder: HOLDER,
          issuerId: TENANT_B.config.issuerId, // Specifying another tenant's issuer account
          attributes: { date_of_birth: "1990-01-01" },
        },
        {
          "x-api-key": TENANT_A.apiKey,
        },
      ),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Unauthorized issuerId for tenant/);
  });

  it("enforces tenant allowed credential types: rejects unauthorized credential type with 403", async () => {
    const { POST } = await loadRouteWithContext();

    // Tenant A is only allowed ["kyc", "age"], attempting to issue "income"
    const res = await POST(
      postRequest(
        {
          credential_types: ["income"],
          holder: HOLDER,
          attributes: { income: "150000" },
        },
        {
          "x-api-key": TENANT_A.apiKey,
        },
      ),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not authorized to issue credential type 'income'/);
  });

  it("rejects invalid or unknown API key with 401 Unauthorized", async () => {
    const { POST } = await loadRouteWithContext();

    const res = await POST(
      postRequest(
        {
          credential_types: ["kyc"],
          holder: HOLDER,
        },
        {
          "x-api-key": "sk_live_unrecognized_fake_key",
        },
      ),
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid API key/);
  });

  it("rejects suspended tenant with 403 Forbidden", async () => {
    const { POST } = await loadRouteWithContext();

    const res = await POST(
      postRequest(
        {
          credential_types: ["kyc"],
          holder: HOLDER,
        },
        {
          "x-api-key": SUSPENDED_TENANT.apiKey,
        },
      ),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/suspended/);
  });
});
