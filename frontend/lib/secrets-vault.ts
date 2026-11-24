// Server-side only — never shipped to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/secrets-vault.ts is server-only and must not be imported from client code.");
}

import { logger, stripSensitiveFields } from "./logger";

export interface SecretsProvider {
  readonly name: string;
  getSecret(pathOrKey: string): Promise<string | null>;
  setSecret?(pathOrKey: string, value: string): Promise<void>;
  healthCheck?(): Promise<boolean>;
}

export interface VaultProviderOptions {
  address?: string;
  token?: string;
  namespace?: string;
  mountPath?: string;
  kvVersion?: 1 | 2;
  cacheTtlMs?: number;
}

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

/**
 * HashiCorp Vault KV secrets provider implementation.
 * Connects to Vault HTTP API to retrieve secrets dynamically.
 */
export class VaultSecretsProvider implements SecretsProvider {
  readonly name = "vault";
  private readonly address: string;
  private readonly token: string;
  private readonly namespace?: string;
  private readonly mountPath: string;
  private readonly kvVersion: 1 | 2;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: VaultProviderOptions = {}) {
    this.address = (options.address || process.env.VAULT_ADDR || "http://127.0.0.1:8200").replace(
      /\/+$/,
      "",
    );
    this.token = options.token || process.env.VAULT_TOKEN || "";
    this.namespace = options.namespace || process.env.VAULT_NAMESPACE || undefined;
    this.mountPath = (options.mountPath || process.env.VAULT_MOUNT_PATH || "secret").replace(
      /^\/+|\/+$/g,
      "",
    );
    this.kvVersion = options.kvVersion ?? 2;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
  }

  /**
   * Clears the in-memory secrets cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Fetches a secret from HashiCorp Vault.
   * Supports secret paths with optional field targeting (e.g. "path#field" or "path").
   */
  async getSecret(pathOrKey: string): Promise<string | null> {
    const trimmed = pathOrKey.trim();
    if (!trimmed) return null;

    const [secretPath, specificField] = trimmed.includes("#")
      ? trimmed.split("#")
      : [trimmed, undefined];

    const cleanPath = secretPath.replace(/^\/+|\/+$/g, "");
    const cacheKey = `${cleanPath}#${specificField ?? ""}`;

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (!this.token) {
      logger.warn(
        stripSensitiveFields({
          event: "vault_token_missing",
          secretPath: cleanPath,
        }),
        "VAULT_TOKEN is not configured; cannot fetch secret from Vault.",
      );
      return null;
    }

    try {
      const url =
        this.kvVersion === 2
          ? `${this.address}/v1/${this.mountPath}/data/${cleanPath}`
          : `${this.address}/v1/${this.mountPath}/${cleanPath}`;

      const headers: Record<string, string> = {
        "X-Vault-Token": this.token,
        Accept: "application/json",
      };
      if (this.namespace) {
        headers["X-Vault-Namespace"] = this.namespace;
      }

      const res = await fetch(url, { method: "GET", headers });

      if (res.status === 404) {
        this.cache.set(cacheKey, { value: null, expiresAt: Date.now() + this.cacheTtlMs });
        return null;
      }

      if (!res.ok) {
        logger.error(
          stripSensitiveFields({
            event: "vault_fetch_error",
            status: res.status,
            path: cleanPath,
          }),
          `Failed to fetch secret from Vault: HTTP ${res.status}`,
        );
        return null;
      }

      const json = (await res.json()) as {
        data?: {
          data?: Record<string, unknown>;
          [key: string]: unknown;
        };
      };

      const payload = this.kvVersion === 2 ? json.data?.data : json.data;
      if (!payload || typeof payload !== "object") {
        return null;
      }

      let secretValue: string | null = null;
      if (specificField && specificField in payload) {
        const val = payload[specificField];
        secretValue = typeof val === "string" ? val : JSON.stringify(val);
      } else if ("privateKey" in payload && typeof payload.privateKey === "string") {
        secretValue = payload.privateKey;
      } else if ("signingKey" in payload && typeof payload.signingKey === "string") {
        secretValue = payload.signingKey;
      } else if ("value" in payload && typeof payload.value === "string") {
        secretValue = payload.value;
      } else if ("secret" in payload && typeof payload.secret === "string") {
        secretValue = payload.secret;
      } else if ("key" in payload && typeof payload.key === "string") {
        secretValue = payload.key;
      } else {
        const keys = Object.keys(payload);
        if (keys.length === 1 && typeof payload[keys[0]] === "string") {
          secretValue = payload[keys[0]] as string;
        } else {
          secretValue = JSON.stringify(payload);
        }
      }

      this.cache.set(cacheKey, {
        value: secretValue,
        expiresAt: Date.now() + this.cacheTtlMs,
      });

      return secretValue;
    } catch (err) {
      logger.error(
        stripSensitiveFields({
          event: "vault_request_exception",
          path: cleanPath,
          error: (err as Error).message,
        }),
        "Exception while communicating with HashiCorp Vault.",
      );
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.address}/v1/sys/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      // Vault returns 200 for active, 429 for standby, 472 for DR secondary, 473 for performance standby
      return res.status === 200 || res.status === 429;
    } catch {
      return false;
    }
  }
}

/**
 * Environment variable fallback secrets provider.
 * Normalizes secret path to uppercase environment variable naming.
 */
export class EnvSecretsProvider implements SecretsProvider {
  readonly name = "env";

  async getSecret(pathOrKey: string): Promise<string | null> {
    const trimmed = pathOrKey.trim();
    if (!trimmed) return null;

    // Check exact key first
    if (process.env[trimmed]) {
      return process.env[trimmed]!;
    }

    // Normalized env variable: "stellarcred/tenants/acme/signing-key" -> "STELLARCRED_TENANTS_ACME_SIGNING_KEY"
    const normalizedKey = trimmed
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .toUpperCase();

    if (process.env[normalizedKey]) {
      return process.env[normalizedKey]!;
    }

    // If key ends with signing-key or private-key, fallback to ISSUER_PRIVATE_KEY
    if (
      (normalizedKey.endsWith("SIGNING_KEY") || normalizedKey.endsWith("PRIVATE_KEY")) &&
      process.env.ISSUER_PRIVATE_KEY
    ) {
      return process.env.ISSUER_PRIVATE_KEY;
    }

    return null;
  }

  async setSecret(pathOrKey: string, value: string): Promise<void> {
    process.env[pathOrKey] = value;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/**
 * In-memory Mock Secrets Provider for unit tests.
 */
export class MockSecretsProvider implements SecretsProvider {
  readonly name = "mock";
  private readonly store = new Map<string, string>();

  constructor(initialSecrets: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initialSecrets)) {
      this.store.set(k, v);
    }
  }

  async getSecret(pathOrKey: string): Promise<string | null> {
    return this.store.get(pathOrKey) ?? null;
  }

  async setSecret(pathOrKey: string, value: string): Promise<void> {
    this.store.set(pathOrKey, value);
  }

  async deleteSecret(pathOrKey: string): Promise<boolean> {
    return this.store.delete(pathOrKey);
  }

  clear(): void {
    this.store.clear();
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

let activeSecretsProvider: SecretsProvider | null = null;

/**
 * Resolves the active secrets provider instance.
 * Defaults to VaultSecretsProvider if VAULT_ADDR and VAULT_TOKEN are set,
 * otherwise falls back to EnvSecretsProvider.
 */
export function getSecretsProvider(): SecretsProvider {
  if (activeSecretsProvider) {
    return activeSecretsProvider;
  }

  if (process.env.VAULT_ADDR && process.env.VAULT_TOKEN) {
    activeSecretsProvider = new VaultSecretsProvider();
  } else {
    activeSecretsProvider = new EnvSecretsProvider();
  }

  return activeSecretsProvider;
}

/**
 * Sets or resets the active secrets provider (for testing or configuration changes).
 */
export function setSecretsProvider(provider: SecretsProvider | null): void {
  activeSecretsProvider = provider;
}

/**
 * Resolves an issuer signing key by secret reference.
 * If secretRef is provided, attempts to load it via the active secrets provider.
 * If secretRef is itself a 64-character hex key, returns it directly.
 * Falls back to ISSUER_PRIVATE_KEY or null.
 */
export async function resolveSigningKey(secretRef?: string): Promise<string | null> {
  const provider = getSecretsProvider();

  if (secretRef && secretRef.trim()) {
    const trimmed = secretRef.trim();
    // If it's already a 64-char hex key (e.g. passed directly in test config)
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return trimmed;
    }

    const fromProvider = await provider.getSecret(trimmed);
    if (fromProvider && /^[0-9a-fA-F]{64}$/.test(fromProvider.trim())) {
      return fromProvider.trim();
    }
  }

  // Fallback to default issuer key reference in secrets provider
  const defaultFromProvider = await provider.getSecret("stellarcred/issuer/private-key");
  if (defaultFromProvider && /^[0-9a-fA-F]{64}$/.test(defaultFromProvider.trim())) {
    return defaultFromProvider.trim();
  }

  // Fallback to ISSUER_PRIVATE_KEY from environment
  if (
    process.env.ISSUER_PRIVATE_KEY &&
    /^[0-9a-fA-F]{64}$/.test(process.env.ISSUER_PRIVATE_KEY.trim())
  ) {
    return process.env.ISSUER_PRIVATE_KEY.trim();
  }

  return null;
}
