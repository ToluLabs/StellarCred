// Server-side only — never shipped to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/tenancy.ts is server-only and must not be imported from client code.");
}

import { NextRequest } from "next/server";
import { logger, stripSensitiveFields } from "./logger";

export type TenantStatus = "active" | "suspended" | "revoked";

export interface TenantIssuerConfig {
  issuerId: string;
  issuerName: string;
  /**
   * Reference path to key in secrets provider (e.g. Vault KV path "stellarcred/tenants/acme/signing-key").
   * Plaintext keys must never be stored here.
   */
  signingKeySecretRef: string;
  /**
   * Credential types this tenant is authorized to mint.
   */
  allowedCredentialTypes: string[];
  /**
   * Optional custom template configuration for tenant credentials.
   */
  templates?: Record<string, unknown>;
}

export interface Tenant {
  id: string;
  name: string;
  apiKey: string;
  status: TenantStatus;
  config: TenantIssuerConfig;
  createdAt: string;
  updatedAt: string;
}

export interface TenantResolutionResult {
  tenant: Tenant | null;
  error?: string;
  status?: number;
}

export interface TenantStore {
  getTenantById(id: string): Promise<Tenant | null>;
  getTenantByApiKey(apiKey: string): Promise<Tenant | null>;
  upsertTenant(tenant: Tenant): Promise<void>;
  deleteTenant(id: string): Promise<boolean>;
  listTenants(): Promise<Tenant[]>;
  clear(): void;
}

/**
 * In-memory Tenant Store for runtime caching and testing.
 */
export class InMemoryTenantStore implements TenantStore {
  private readonly tenantsById = new Map<string, Tenant>();
  private readonly tenantsByApiKey = new Map<string, string>(); // apiKey -> id

  constructor(initialTenants: Tenant[] = []) {
    for (const t of initialTenants) {
      this.tenantsById.set(t.id, t);
      this.tenantsByApiKey.set(t.apiKey, t.id);
    }
  }

  async getTenantById(id: string): Promise<Tenant | null> {
    return this.tenantsById.get(id) ?? null;
  }

  async getTenantByApiKey(apiKey: string): Promise<Tenant | null> {
    const id = this.tenantsByApiKey.get(apiKey);
    if (!id) return null;
    return this.tenantsById.get(id) ?? null;
  }

  async upsertTenant(tenant: Tenant): Promise<void> {
    // If updating, clean previous API key mapping
    const existing = this.tenantsById.get(tenant.id);
    if (existing && existing.apiKey !== tenant.apiKey) {
      this.tenantsByApiKey.delete(existing.apiKey);
    }
    this.tenantsById.set(tenant.id, tenant);
    this.tenantsByApiKey.set(tenant.apiKey, tenant.id);
  }

  async deleteTenant(id: string): Promise<boolean> {
    const existing = this.tenantsById.get(id);
    if (!existing) return false;
    this.tenantsByApiKey.delete(existing.apiKey);
    return this.tenantsById.delete(id);
  }

  async listTenants(): Promise<Tenant[]> {
    return Array.from(this.tenantsById.values());
  }

  clear(): void {
    this.tenantsById.clear();
    this.tenantsByApiKey.clear();
  }
}

// Built-in default store instance
let activeTenantStore: TenantStore = new InMemoryTenantStore();

export function getTenantStore(): TenantStore {
  return activeTenantStore;
}

export function setTenantStore(store: TenantStore): void {
  activeTenantStore = store;
}

/**
 * Register a tenant in the active store.
 */
export async function registerTenant(tenant: Tenant): Promise<void> {
  await activeTenantStore.upsertTenant(tenant);
}

/**
 * Helper to extract an API key or auth header from incoming request headers.
 */
function extractAuthCredentials(headers: Headers | Record<string, string | null | undefined>): {
  tenantId?: string;
  apiKey?: string;
} {
  const getHeader = (name: string): string | undefined => {
    if ("get" in headers && typeof headers.get === "function") {
      return headers.get(name)?.trim() || undefined;
    }
    const rec = headers as Record<string, string | null | undefined>;
    const direct = rec[name] || rec[name.toLowerCase()];
    return direct ? String(direct).trim() : undefined;
  };

  const tenantId = getHeader("x-tenant-id");
  let apiKey = getHeader("x-api-key");

  if (!apiKey) {
    const authHeader = getHeader("authorization");
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      apiKey = authHeader.slice(7).trim();
    }
  }

  return { tenantId, apiKey };
}

/**
 * Custom error thrown when cross-tenant access is attempted.
 */
export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

/**
 * Asserts that the authenticated tenant owns or matches the requested tenant ID.
 * Throws TenantIsolationError if isolation is breached.
 */
export function assertTenantIsolation(authenticatedTenant: Tenant, targetTenantId: string): void {
  if (authenticatedTenant.id !== targetTenantId) {
    throw new TenantIsolationError(
      `Access denied: Tenant '${authenticatedTenant.id}' cannot access resources belonging to tenant '${targetTenantId}'.`,
    );
  }
}

/**
 * Resolves and authenticates the tenant from request headers.
 *
 * Rules:
 * - If NO tenant headers are provided, returns { tenant: null } (permits default deployment issuer).
 * - If API key is provided, looks up tenant and verifies active status.
 * - If BOTH x-tenant-id and API key are provided, enforces strict tenant matching (cross-tenant rejection).
 * - If x-tenant-id is provided without an API key, rejects with 401 Unauthorized.
 */
export async function resolveTenant(
  reqOrHeaders: NextRequest | Headers | Record<string, string | null | undefined>,
): Promise<TenantResolutionResult> {
  const headers =
    reqOrHeaders instanceof NextRequest
      ? reqOrHeaders.headers
      : "get" in reqOrHeaders
        ? (reqOrHeaders as Headers)
        : reqOrHeaders;

  const { tenantId, apiKey } = extractAuthCredentials(headers);

  // No tenant authentication headers present -> default system flow
  if (!tenantId && !apiKey) {
    return { tenant: null };
  }

  // Tenant ID requested without credentials
  if (tenantId && !apiKey) {
    logger.warn(
      stripSensitiveFields({
        event: "tenant_auth_missing_credentials",
        tenantId,
      }),
      "Request specified x-tenant-id but no API key or Authorization header was provided.",
    );
    return {
      tenant: null,
      error: "API key or Authorization header is required for tenant access.",
      status: 401,
    };
  }

  // API key provided
  const store = getTenantStore();
  const tenant = await store.getTenantByApiKey(apiKey!);

  if (!tenant) {
    logger.warn(
      stripSensitiveFields({
        event: "tenant_auth_invalid_api_key",
        tenantId,
      }),
      "Invalid or unrecognized tenant API key.",
    );
    return {
      tenant: null,
      error: "Invalid API key.",
      status: 401,
    };
  }

  // Cross-tenant access check: If client provided x-tenant-id, it MUST match the API key's tenant
  if (tenantId && tenant.id !== tenantId) {
    logger.warn(
      stripSensitiveFields({
        event: "cross_tenant_access_blocked",
        authenticatedTenant: tenant.id,
        targetTenant: tenantId,
      }),
      `Tenant isolation violation: authenticated tenant '${tenant.id}' attempted access as '${tenantId}'.`,
    );
    return {
      tenant: null,
      error: `Tenant isolation violation: API key does not have access to tenant '${tenantId}'.`,
      status: 403,
    };
  }

  // Check tenant status
  if (tenant.status === "suspended") {
    logger.warn(
      stripSensitiveFields({
        event: "tenant_suspended",
        tenantId: tenant.id,
      }),
      `Tenant '${tenant.id}' is currently suspended.`,
    );
    return {
      tenant: null,
      error: `Tenant '${tenant.id}' is suspended. Please contact administrator.`,
      status: 403,
    };
  }

  if (tenant.status === "revoked") {
    logger.warn(
      stripSensitiveFields({
        event: "tenant_revoked",
        tenantId: tenant.id,
      }),
      `Tenant '${tenant.id}' has been revoked.`,
    );
    return {
      tenant: null,
      error: `Tenant '${tenant.id}' has been revoked.`,
      status: 403,
    };
  }

  return { tenant };
}

/**
 * Validates that all requested credential types are allowed under the tenant's configuration.
 */
export function validateTenantCredentialTypes(
  tenant: Tenant,
  requestedTypes: string[],
): { allowed: boolean; disallowedType?: string } {
  const allowed = tenant.config.allowedCredentialTypes;
  // Wildcard allowed
  if (allowed.includes("*")) {
    return { allowed: true };
  }

  for (const type of requestedTypes) {
    if (!allowed.includes(type)) {
      return { allowed: false, disallowedType: type };
    }
  }

  return { allowed: true };
}
