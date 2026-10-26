// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  getTenantStore,
  InMemoryTenantStore,
  setTenantStore,
  type Tenant,
  type TenantStore,
} from "@/lib/tenancy";
import { authenticateTenant, authErrorResponse, requireAdmin } from "../_middleware";

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/test", { headers });
}

function tenant(id: string, apiKey: string, status: Tenant["status"]): Tenant {
  return {
    id,
    name: id,
    apiKey,
    status,
    config: {
      issuerId: "GTEST",
      issuerName: "Test Authority",
      signingKeySecretRef: `secret/${id}`,
      allowedCredentialTypes: ["age"],
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("requireAdmin", () => {
  const ORIGINAL_KEY = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = "admin-secret";
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = ORIGINAL_KEY;
  });

  it("lets a valid admin key through", () => {
    expect(requireAdmin(request({ authorization: "Bearer admin-secret" }))).toBeNull();
  });

  it.each([
    ["no header", {}],
    ["invalid key", { authorization: "Bearer wrong-secret" }],
    ["wrong scheme", { authorization: "Basic admin-secret" }],
    ["key in x-api-key only", { "x-api-key": "admin-secret" }],
  ])("returns 401 Unauthorized for %s", async (_label, headers) => {
    const res = requireAdmin(request(headers as Record<string, string>));
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 for every request when ADMIN_API_KEY is unset", () => {
    delete process.env.ADMIN_API_KEY;
    expect(requireAdmin(request({ authorization: "Bearer admin-secret" }))?.status).toBe(401);
  });
});

describe("authenticateTenant", () => {
  let originalStore: TenantStore;
  const ACTIVE = tenant("tenant_active", "sk_active", "active");

  beforeAll(() => {
    originalStore = getTenantStore();
    setTenantStore(
      new InMemoryTenantStore([
        ACTIVE,
        tenant("tenant_suspended", "sk_suspended", "suspended"),
        tenant("tenant_revoked", "sk_revoked", "revoked"),
      ]),
    );
  });

  afterAll(() => {
    setTenantStore(originalStore);
  });

  it("resolves to null when no tenant credentials are sent", async () => {
    expect(await authenticateTenant(request())).toEqual({ ok: true, value: null });
  });

  it("resolves the tenant from x-api-key or a Bearer token", async () => {
    const viaHeader = await authenticateTenant(request({ "x-api-key": "sk_active" }));
    const viaBearer = await authenticateTenant(request({ authorization: "Bearer sk_active" }));
    expect(viaHeader).toEqual({ ok: true, value: ACTIVE });
    expect(viaBearer).toEqual({ ok: true, value: ACTIVE });
  });

  it.each([
    ["invalid API key", { "x-api-key": "sk_unknown" }, 401],
    ["tenant id without a key", { "x-tenant-id": "tenant_active" }, 401],
    ["cross-tenant key", { "x-api-key": "sk_active", "x-tenant-id": "tenant_other" }, 403],
    ["suspended tenant", { "x-api-key": "sk_suspended" }, 403],
    ["revoked tenant", { "x-api-key": "sk_revoked" }, 403],
  ])("rejects a %s", async (_label, headers, status) => {
    const result = await authenticateTenant(request(headers as Record<string, string>));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(status);
  });

  it("renders a rejection as JSON with the request id", async () => {
    const res = authErrorResponse({ status: 403, error: "denied" }, "req-123");
    expect(res.status).toBe(403);
    expect(res.headers.get("x-request-id")).toBe("req-123");
    expect(await res.json()).toEqual({ error: "denied" });
  });
});
