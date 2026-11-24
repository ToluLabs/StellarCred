// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  VaultSecretsProvider,
  EnvSecretsProvider,
  MockSecretsProvider,
  getSecretsProvider,
  setSecretsProvider,
  resolveSigningKey,
} from "./secrets-vault";

describe("lib/secrets-vault", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setSecretsProvider(null);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    setSecretsProvider(null);
    vi.restoreAllMocks();
  });

  describe("EnvSecretsProvider", () => {
    it("returns exact match environment variable", async () => {
      process.env.MY_SECRET_KEY = "secret123";
      const provider = new EnvSecretsProvider();
      expect(await provider.getSecret("MY_SECRET_KEY")).toBe("secret123");
    });

    it("normalizes path to uppercase env variable", async () => {
      process.env.STELLARCRED_TENANTS_ACME_SIGNING_KEY =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      const provider = new EnvSecretsProvider();
      const val = await provider.getSecret("stellarcred/tenants/acme/signing-key");
      expect(val).toBe("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    });

    it("falls back to ISSUER_PRIVATE_KEY for signing-key path if specific key is unset", async () => {
      process.env.ISSUER_PRIVATE_KEY = "aabb".repeat(16);
      const provider = new EnvSecretsProvider();
      const val = await provider.getSecret("tenants/unknown/signing-key");
      expect(val).toBe("aabb".repeat(16));
    });

    it("returns null for unset key without fallback", async () => {
      const provider = new EnvSecretsProvider();
      expect(await provider.getSecret("completely_unknown_secret")).toBeNull();
    });

    it("passes healthCheck", async () => {
      const provider = new EnvSecretsProvider();
      expect(await provider.healthCheck()).toBe(true);
    });
  });

  describe("VaultSecretsProvider", () => {
    it("fetches KV v2 secret and resolves privateKey property", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            data: {
              privateKey: "1122".repeat(16),
              issuerId: "GBBB...",
            },
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new VaultSecretsProvider({
        address: "http://vault.local:8200",
        token: "s.vaulttoken123",
        mountPath: "secret",
        kvVersion: 2,
      });

      const secret = await provider.getSecret("stellarcred/tenants/bank/signing-key");
      expect(secret).toBe("1122".repeat(16));
      expect(mockFetch).toHaveBeenCalledWith(
        "http://vault.local:8200/v1/secret/data/stellarcred/tenants/bank/signing-key",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Vault-Token": "s.vaulttoken123",
          }),
        }),
      );
    });

    it("supports targeted field extraction via hash syntax", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            data: {
              customField: "custom_secret_value",
            },
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new VaultSecretsProvider({
        address: "http://vault.local:8200",
        token: "s.vaulttoken123",
      });

      const val = await provider.getSecret("stellarcred/tenants/bank/config#customField");
      expect(val).toBe("custom_secret_value");
    });

    it("caches secrets in memory to prevent duplicate network calls", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            data: { value: "cached_val" },
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const provider = new VaultSecretsProvider({
        address: "http://vault.local:8200",
        token: "s.test",
        cacheTtlMs: 10_000,
      });

      const first = await provider.getSecret("path/to/key");
      const second = await provider.getSecret("path/to/key");

      expect(first).toBe("cached_val");
      expect(second).toBe("cached_val");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns null when Vault responds with 404", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        }),
      );

      const provider = new VaultSecretsProvider({
        token: "s.token",
      });

      expect(await provider.getSecret("nonexistent/key")).toBeNull();
    });

    it("handles network failure gracefully without throwing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

      const provider = new VaultSecretsProvider({
        token: "s.token",
      });

      expect(await provider.getSecret("path/fails")).toBeNull();
    });

    it("checks Vault health correctly", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 200,
        }),
      );

      const provider = new VaultSecretsProvider({ address: "http://vault.local:8200" });
      expect(await provider.healthCheck()).toBe(true);
    });
  });

  describe("MockSecretsProvider & Factory", () => {
    it("stores and retrieves mock secrets", async () => {
      const mock = new MockSecretsProvider({
        "my/secret": "mock_secret_value",
      });
      expect(await mock.getSecret("my/secret")).toBe("mock_secret_value");
      expect(await mock.getSecret("unknown")).toBeNull();

      await mock.setSecret("new/secret", "new_val");
      expect(await mock.getSecret("new/secret")).toBe("new_val");
    });

    it("getSecretsProvider returns EnvSecretsProvider by default", () => {
      delete process.env.VAULT_ADDR;
      delete process.env.VAULT_TOKEN;
      const provider = getSecretsProvider();
      expect(provider.name).toBe("env");
    });

    it("getSecretsProvider returns VaultSecretsProvider when VAULT_ADDR and VAULT_TOKEN are set", () => {
      process.env.VAULT_ADDR = "http://127.0.0.1:8200";
      process.env.VAULT_TOKEN = "s.token123";
      setSecretsProvider(null);
      const provider = getSecretsProvider();
      expect(provider.name).toBe("vault");
    });

    it("resolveSigningKey returns direct hex keys or resolves references", async () => {
      const hexKey = "aa".repeat(32);
      expect(await resolveSigningKey(hexKey)).toBe(hexKey);

      const mock = new MockSecretsProvider({
        "vault/tenant1/key": "bb".repeat(32),
      });
      setSecretsProvider(mock);

      expect(await resolveSigningKey("vault/tenant1/key")).toBe("bb".repeat(32));
    });
  });
});
