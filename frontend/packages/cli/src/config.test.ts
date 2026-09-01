import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { loadConfig } from "./config";

const ENV_KEYS = [
  "STELLARCRED_RPC_URL",
  "NEXT_PUBLIC_RPC_URL",
  "STELLARCRED_NETWORK_PASSPHRASE",
  "NEXT_PUBLIC_NETWORK_PASSPHRASE",
  "STELLARCRED_NETWORK",
  "NEXT_PUBLIC_STELLAR_NETWORK",
  "STELLARCRED_BASE_URL",
  "NEXT_PUBLIC_STELLARCRED_BASE_URL",
  "STELLARCRED_REGISTRY_ID",
  "NEXT_PUBLIC_PROOF_REGISTRY_ID",
  "STELLARCRED_ISSUER_REGISTRY_ID",
  "NEXT_PUBLIC_ISSUER_REGISTRY_ID",
  "STELLARCRED_SIM_ACCOUNT",
  "NEXT_PUBLIC_ISSUER_ADDRESS",
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("loadConfig", () => {
  it("falls back to testnet defaults when nothing is set", () => {
    const cfg = loadConfig();
    expect(cfg.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(cfg.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(cfg.network).toBe("testnet");
    expect(cfg.baseUrl).toBe("https://stellarcred.xyz");
    expect(cfg.proofRegistryId).toBe("");
    expect(cfg.issuerRegistryId).toBe("");
  });

  it("prefers STELLARCRED_* over NEXT_PUBLIC_* when both are set", () => {
    process.env.STELLARCRED_RPC_URL = "https://server-only.example";
    process.env.NEXT_PUBLIC_RPC_URL = "https://public.example";
    expect(loadConfig().rpcUrl).toBe("https://server-only.example");
  });

  it("falls back to NEXT_PUBLIC_* when the server-only var is unset", () => {
    process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID = "CPROOF";
    process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "CISSUER";
    process.env.NEXT_PUBLIC_ISSUER_ADDRESS = "GADDR";
    const cfg = loadConfig();
    expect(cfg.proofRegistryId).toBe("CPROOF");
    expect(cfg.issuerRegistryId).toBe("CISSUER");
    expect(cfg.simAccount).toBe("GADDR");
  });

  it("lets explicit overrides win over env vars", () => {
    process.env.STELLARCRED_RPC_URL = "https://from-env.example";
    const cfg = loadConfig({ rpcUrl: "https://from-flag.example" });
    expect(cfg.rpcUrl).toBe("https://from-flag.example");
  });
});
