// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  InMemoryTenantStore,
  resolveTenant,
  assertTenantIsolation,
  validateTenantCredentialTypes,
  TenantIsolationError,
  setTenantStore,
  registerTenant,
  type Tenant,
} from "./tenancy";

describe("lib/tenancy", () => {
  const TENANT_A: Tenant = {
    id: "org_alpha",
    name: "Alpha Corp",
    apiKey: "sk_live_alpha_11111111111111111111",
    status: "active",
    config: {
      issuerId: "GALPHA000000000000000000000000000000000000000000000000000",
      issuerName: "Alpha Authority",
      signingKeySecretRef: "stellarcred/tenants/alpha/signing-key",
      allowedCredentialTypes: ["kyc", "age"],
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const TENANT_B: Tenant = {
    id: "org_beta",
    name: "Beta Ltd",
    apiKey: "sk_live_beta_22222222222222222222",
    status: "active",
    config: {
      issuerId: "GBETA0000000000000000000000000000000000000000000000000000",
      issuerName: "Beta Authority",
      signingKeySecretRef: "stellarcred/tenants/beta/signing-key",
      allowedCredentialTypes: ["funds", "income"],
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const SUSPENDED_TENANT: Tenant = {
    id: "org_suspended",
    name: "Suspended Org",
    apiKey: "sk_live_suspended_33333333333333333333",
    status: "suspended",
    config: {
      issuerId: "GSUSPENDED000000000000000000000000000000000000000000000000",
      issuerName: "Suspended Authority",
      signingKeySecretRef: "stellarcred/tenants/suspended/signing-key",
      allowedCredentialTypes: ["kyc"],
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  const REVOKED_TENANT: Tenant = {
    id: "org_revoked",
    name: "Revoked Org",
    apiKey: "sk_live_revoked_44444444444444444444",
    status: "revoked",
    config: {
      issuerId: "GREVOKED00000000000000000000000000000000000000000000000000",
      issuerName: "Revoked Authority",
      signingKeySecretRef: "stellarcred/tenants/revoked/signing-key",
      allowedCredentialTypes: ["kyc"],
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  let store: InMemoryTenantStore;

  beforeEach(async () => {
    store = new InMemoryTenantStore([TENANT_A, TENANT_B, SUSPENDED_TENANT, REVOKED_TENANT]);
    setTenantStore(store);
  });

  describe("Tenant Store", () => {
    it("retrieves tenant by ID and by API key", async () => {
      expect(await store.getTenantById("org_alpha")).toEqual(TENANT_A);
      expect(await store.getTenantByApiKey("sk_live_alpha_11111111111111111111")).toEqual(TENANT_A);
      expect(await store.getTenantById("unknown")).toBeNull();
      expect(await store.getTenantByApiKey("invalid_key")).toBeNull();
    });

    it("supports upserting and deleting tenants", async () => {
      const newTenant: Tenant = {
        id: "org_gamma",
        name: "Gamma Corp",
        apiKey: "sk_live_gamma_555",
        status: "active",
        config: {
          issuerId: "GGAMMA...",
          issuerName: "Gamma Authority",
          signingKeySecretRef: "secret/gamma",
          allowedCredentialTypes: ["kyc"],
        },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      await registerTenant(newTenant);
      expect(await store.getTenantById("org_gamma")).toEqual(newTenant);

      const deleted = await store.deleteTenant("org_gamma");
      expect(deleted).toBe(true);
      expect(await store.getTenantById("org_gamma")).toBeNull();
    });
  });

  describe("resolveTenant Authentication & Isolation", () => {
    it("returns null tenant when no tenant headers are provided (backward-compatible)", async () => {
      const req = new NextRequest("http://localhost/api/issue", {
        method: "POST",
      });
      const result = await resolveTenant(req);
      expect(result.tenant).toBeNull();
      expect(result.error).toBeUndefined();
    });

    it("resolves tenant from x-api-key header", async () => {
      const req = new NextRequest("http://localhost/api/issue", {
        method: "POST",
        headers: { "x-api-key": TENANT_A.apiKey },
      });
      const result = await resolveTenant(req);
      expect(result.tenant).toEqual(TENANT_A);
    });

    it("resolves tenant from Authorization: Bearer header", async () => {
      const req = new NextRequest("http://localhost/api/issue", {
        method: "POST",
        headers: { authorization: `Bearer ${TENANT_B.apiKey}` },
      });
      const result = await resolveTenant(req);
      expect(result.tenant).toEqual(TENANT_B);
    });

    it("rejects invalid or unknown API keys with 401 Unauthorized", async () => {
      const req = new NextRequest("http://localhost/api/issue", {
        method: "POST",
        headers: { "x-api-key": "sk_live_bogus_key" },
      });
      const result = await resolveTenant(req);
      expect(result.tenant).toBeNull();
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/Invalid API key/);
    });

    it("rejects request with x-tenant-id but no API key with 401 Unauthorized", async () => {
      const req = new NextRequest("http://localhost/api/issue", {
        method: "POST",
        headers: { "x-tenant-id": "org_alpha" },
      });
      const result = await resolveTenant(req);
      expect(result.tenant).toBeNull();
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/API key or Authorization header is required/);
    });

    // ── STRICT TENANT ISOLATION TESTS ──────────────────────────────────────────
    it("ENFORCES TENANT ISOLATION: rejects Tenant A attempting to access Tenant B configs with 403 Forbidden", async () => {
      // Authenticated with Tenant A's API key, but requesting x-tenant-id: org_beta
      const req = new NextRequest("http://localhost/api/issue", {
        method: "POST",
        headers: {
          "x-api-key": TENANT_A.apiKey,
          "x-tenant-id": "org_beta",
        },
      });
      const result = await resolveTenant(req);
      expect(result.tenant).toBeNull();
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/Tenant isolation violation/);
    });

    it("ENFORCES TENANT ISOLATION: rejects Tenant B attempting to access Tenant A configs with 403 Forbidden", async () => {
      // Authenticated with Tenant B's API key, but requesting x-tenant-id: org_alpha
      const req = new NextRequest("http://localhost/api/issue", {
        method: "POST",
        headers: {
          "x-api-key": TENANT_B.apiKey,
          "x-tenant-id": "org_alpha",
        },
      });
      const result = await resolveTenant(req);
      expect(result.tenant).toBeNull();
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/Tenant isolation violation/);
    });

    it("allows matching x-tenant-id and API key for the same tenant", async () => {
      const req = new NextRequest("http://localhost/api/issue", {
        method: "POST",
        headers: {
          "x-api-key": TENANT_A.apiKey,
          "x-tenant-id": "org_alpha",
        },
      });
      const result = await resolveTenant(req);
      expect(result.tenant).toEqual(TENANT_A);
      expect(result.error).toBeUndefined();
    });

    it("rejects suspended tenant with 403 Forbidden", async () => {
      const req = new NextRequest("http://localhost/api/issue", {
        method: "POST",
        headers: { "x-api-key": SUSPENDED_TENANT.apiKey },
      });
      const result = await resolveTenant(req);
      expect(result.tenant).toBeNull();
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/suspended/);
    });

    it("rejects revoked tenant with 403 Forbidden", async () => {
      const req = new NextRequest("http://localhost/api/issue", {
        method: "POST",
        headers: { "x-api-key": REVOKED_TENANT.apiKey },
      });
      const result = await resolveTenant(req);
      expect(result.tenant).toBeNull();
      expect(result.status).toBe(403);
      expect(result.error).toMatch(/revoked/);
    });
  });

  describe("assertTenantIsolation Helper", () => {
    it("passes when authenticated tenant matches target tenant ID", () => {
      expect(() => assertTenantIsolation(TENANT_A, "org_alpha")).not.toThrow();
    });

    it("throws TenantIsolationError when attempting cross-tenant access", () => {
      expect(() => assertTenantIsolation(TENANT_A, "org_beta")).toThrow(TenantIsolationError);
      expect(() => assertTenantIsolation(TENANT_B, "org_alpha")).toThrow(TenantIsolationError);
    });
  });

  describe("validateTenantCredentialTypes", () => {
    it("allows types that are explicitly permitted in tenant config", () => {
      expect(validateTenantCredentialTypes(TENANT_A, ["kyc"])).toEqual({ allowed: true });
      expect(validateTenantCredentialTypes(TENANT_A, ["kyc", "age"])).toEqual({ allowed: true });
    });

    it("rejects credential types not permitted in tenant config", () => {
      const result = validateTenantCredentialTypes(TENANT_A, ["funds"]);
      expect(result.allowed).toBe(false);
      expect(result.disallowedType).toBe("funds");
    });

    it("supports wildcard permission '*'", () => {
      const wildcardTenant: Tenant = {
        ...TENANT_A,
        config: {
          ...TENANT_A.config,
          allowedCredentialTypes: ["*"],
        },
      };
      expect(
        validateTenantCredentialTypes(wildcardTenant, ["funds", "employment", "income"]),
      ).toEqual({
        allowed: true,
      });
    });
  });
});
