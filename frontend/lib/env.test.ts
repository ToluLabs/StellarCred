// @vitest-environment node
import { describe, it, expect } from "vitest";
import { loadEnv, EnvValidationError } from "./env";

describe("loadEnv", () => {
  it("boots with every key unset, defaulting to current mock/dev behavior", () => {
    const env = loadEnv({});
    expect(env.NEXT_PUBLIC_STELLAR_NETWORK).toBe("testnet");
    expect(env.NEXT_PUBLIC_RPC_URL).toBe("https://soroban-testnet.stellar.org");
    expect(env.PLAID_ENV).toBe("sandbox");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.ISSUER_PRIVATE_KEY).toBeUndefined();
    expect(env.NEXT_PUBLIC_ISSUER_ADDRESS).toBeUndefined();
  });

  it("treats blank .env.example-style empty strings the same as unset", () => {
    const env = loadEnv({
      NEXT_PUBLIC_ISSUER_ADDRESS: "",
      ISSUER_PRIVATE_KEY: "",
      PERSONA_API_KEY: "",
      NEXT_PUBLIC_ISSUER_REGISTRY_ID: "",
    });
    expect(env.NEXT_PUBLIC_ISSUER_ADDRESS).toBeUndefined();
    expect(env.ISSUER_PRIVATE_KEY).toBeUndefined();
    expect(env.PERSONA_API_KEY).toBeUndefined();
    expect(env.NEXT_PUBLIC_ISSUER_REGISTRY_ID).toBeUndefined();
  });

  it("accepts a well-formed ISSUER_PRIVATE_KEY", () => {
    const env = loadEnv({ ISSUER_PRIVATE_KEY: "ab".repeat(32) });
    expect(env.ISSUER_PRIVATE_KEY).toBe("ab".repeat(32));
  });

  it("rejects a malformed ISSUER_PRIVATE_KEY", () => {
    expect(() => loadEnv({ ISSUER_PRIVATE_KEY: "not-hex" })).toThrow(EnvValidationError);
  });

  it("rejects a malformed NEXT_PUBLIC_ISSUER_ADDRESS", () => {
    expect(() => loadEnv({ NEXT_PUBLIC_ISSUER_ADDRESS: "not-an-address" })).toThrow(
      EnvValidationError,
    );
  });

  it("accepts a well-formed NEXT_PUBLIC_ISSUER_ADDRESS", () => {
    const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const env = loadEnv({ NEXT_PUBLIC_ISSUER_ADDRESS: address });
    expect(env.NEXT_PUBLIC_ISSUER_ADDRESS).toBe(address);
  });

  it("rejects an unrecognized NEXT_PUBLIC_STELLAR_NETWORK value", () => {
    expect(() => loadEnv({ NEXT_PUBLIC_STELLAR_NETWORK: "devnet" })).toThrow(EnvValidationError);
  });

  it("rejects PERSONA_API_KEY without PERSONA_KYC_TEMPLATE_ID", () => {
    expect(() => loadEnv({ PERSONA_API_KEY: "persona_sandbox_x" })).toThrow(EnvValidationError);
  });

  it("accepts PERSONA_API_KEY with PERSONA_KYC_TEMPLATE_ID", () => {
    const env = loadEnv({
      PERSONA_API_KEY: "persona_sandbox_x",
      PERSONA_KYC_TEMPLATE_ID: "itmpl_123",
    });
    expect(env.PERSONA_API_KEY).toBe("persona_sandbox_x");
    expect(env.PERSONA_KYC_TEMPLATE_ID).toBe("itmpl_123");
  });

  it("accepts PERSONA_WEBHOOK_SECRET", () => {
    const env = loadEnv({
      PERSONA_WEBHOOK_SECRET: "whsec_test123",
    });
    expect(env.PERSONA_WEBHOOK_SECRET).toBe("whsec_test123");
  });

  it("rejects a partial Plaid configuration", () => {
    expect(() => loadEnv({ PLAID_ACCESS_TOKEN: "access-sandbox-x" })).toThrow(EnvValidationError);
    expect(() => loadEnv({ PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec" })).toThrow(
      EnvValidationError,
    );
  });

  it("accepts a complete Plaid configuration", () => {
    const env = loadEnv({
      PLAID_CLIENT_ID: "cid",
      PLAID_SECRET: "sec",
      PLAID_ACCESS_TOKEN: "access-sandbox-x",
    });
    expect(env.PLAID_CLIENT_ID).toBe("cid");
  });

  it("rejects a NEXT_PUBLIC_-prefixed server secret before running schema validation", () => {
    expect(() => loadEnv({ NEXT_PUBLIC_ISSUER_PRIVATE_KEY: "leaked" })).toThrow(
      EnvValidationError,
    );
    expect(() => loadEnv({ NEXT_PUBLIC_PLAID_SECRET: "leaked" })).toThrow(EnvValidationError);
    expect(() => loadEnv({ NEXT_PUBLIC_PERSONA_WEBHOOK_SECRET: "leaked" })).toThrow(
      EnvValidationError,
    );
  });

  it("reports multiple invalid base fields in a single error rather than failing on the first", () => {
    try {
      loadEnv({ ISSUER_PRIVATE_KEY: "bad", NEXT_PUBLIC_STELLAR_NETWORK: "bogus" });
      expect.fail("expected loadEnv to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const message = (e as EnvValidationError).message;
      expect(message).toContain("ISSUER_PRIVATE_KEY");
      expect(message).toContain("NEXT_PUBLIC_STELLAR_NETWORK");
    }
  });

  it("reports both missing Plaid keys together when only one of three is set", () => {
    try {
      loadEnv({ PLAID_ACCESS_TOKEN: "access-sandbox-x" });
      expect.fail("expected loadEnv to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const message = (e as EnvValidationError).message;
      expect(message).toContain("PLAID_CLIENT_ID");
      expect(message).toContain("PLAID_SECRET");
    }
  });
});