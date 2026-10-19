import { describe, it, expect } from "vitest";
import {
  validateDeployEnv,
  DEPRECATED_TYPO_VARS,
} from "../../scripts/validate-deploy-env.mjs";

describe("validateDeployEnv", () => {
  it("rejects deprecated NEXT_PUBLIC_CONTRACT_ID typo with descriptive guidance", () => {
    const result = validateDeployEnv({
      NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
      NEXT_PUBLIC_CONTRACT_ID: "CB2R3O43TX3G3N3X4Y5Z6A7B8C9D0E1F2G3H4I5J6K7L8M9N0O",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("NEXT_PUBLIC_CONTRACT_ID"),
      ]),
    );
    expect(result.errors[0]).toContain(DEPRECATED_TYPO_VARS.NEXT_PUBLIC_CONTRACT_ID);
  });

  it("rejects staging deploy when NEXT_PUBLIC_PROOF_REGISTRY_ID is missing", () => {
    const result = validateDeployEnv({
      NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("NEXT_PUBLIC_PROOF_REGISTRY_ID must be defined"),
      ]),
    );
  });

  it("rejects invalid NEXT_PUBLIC_STELLAR_NETWORK", () => {
    const result = validateDeployEnv({
      NEXT_PUBLIC_STELLAR_NETWORK: "ropsten",
      NEXT_PUBLIC_PROOF_REGISTRY_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Invalid NEXT_PUBLIC_STELLAR_NETWORK"),
      ]),
    );
  });

  it("rejects server secrets leaked into NEXT_PUBLIC_ namespace", () => {
    const result = validateDeployEnv({
      NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
      NEXT_PUBLIC_PROOF_REGISTRY_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      NEXT_PUBLIC_ISSUER_PRIVATE_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Critical Security Leak"),
      ]),
    );
  });

  it("validates contract deployment target requires ISSUER_PRIVATE_KEY", () => {
    const missing = validateDeployEnv({}, { target: "contracts" });
    expect(missing.valid).toBe(false);
    expect(missing.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ISSUER_PRIVATE_KEY"),
      ]),
    );

    const invalidHex = validateDeployEnv(
      { ISSUER_PRIVATE_KEY: "invalid-key" },
      { target: "contracts" },
    );
    expect(invalidHex.valid).toBe(false);
    expect(invalidHex.errors[0]).toContain("64-character hexadecimal");

    const validContracts = validateDeployEnv(
      { ISSUER_PRIVATE_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
      { target: "contracts" },
    );
    expect(validContracts.valid).toBe(true);
    expect(validContracts.errors).toHaveLength(0);
  });

  it("accepts valid staging and production environment configs", () => {
    const valid = validateDeployEnv({
      NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
      NEXT_PUBLIC_PROOF_REGISTRY_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      NEXT_PUBLIC_ISSUER_REGISTRY_ID: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      NEXT_PUBLIC_GATED_POOL_ID: "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    });

    expect(valid.valid).toBe(true);
    expect(valid.errors).toHaveLength(0);
  });
});
