import { describe, it, expect, beforeEach } from "vitest";
import * as indexExports from "../index";
import * as claimsExports from "../claims";
import * as errorsExports from "../errors";
import StellarCred from "../index";

describe("SDK deduplication (#522)", () => {
  beforeEach(() => {
    claimsExports.resetConfig();
  });

  it("exports identical function references between index and claims", () => {
    expect(indexExports.hasClaim).toBe(claimsExports.hasClaim);
    expect(indexExports.hasClaims).toBe(claimsExports.hasClaims);
    expect(indexExports.getClaim).toBe(claimsExports.getClaim);
    expect(indexExports.getClaims).toBe(claimsExports.getClaims);
    expect(indexExports.verifyPreset).toBe(claimsExports.verifyPreset);
    expect(indexExports.configure).toBe(claimsExports.configure);
    expect(indexExports.healthCheck).toBe(claimsExports.healthCheck);
    expect(indexExports.isConfigured).toBe(claimsExports.isConfigured);
    expect(indexExports.watchClaim).toBe(claimsExports.watchClaim);
    expect(indexExports.buildVerifyUrl).toBe(claimsExports.buildVerifyUrl);
    expect(indexExports.buildBadgeUrl).toBe(claimsExports.buildBadgeUrl);
    expect(indexExports.buildBadgeEmbedCode).toBe(claimsExports.buildBadgeEmbedCode);
    expect(indexExports.parseReturnParams).toBe(claimsExports.parseReturnParams);
  });

  it("exports identical error classes between index and claims", () => {
    expect(indexExports.ConfigError).toBe(claimsExports.ConfigError);
    expect(indexExports.InvalidAddressError).toBe(claimsExports.InvalidAddressError);
    expect(indexExports.TimeoutError).toBe(claimsExports.TimeoutError);
    expect(indexExports.IndexerError).toBe(claimsExports.IndexerError);
  });

  it("exports RpcError from errors.ts (issue #404)", () => {
    expect(indexExports.RpcError).toBe(errorsExports.RpcError);
    expect(indexExports.ContractError).toBe(errorsExports.ContractError);
    expect(indexExports.ContractErrorCode).toBe(errorsExports.ContractErrorCode);
  });

  it("exports identical CLAIM_TYPES array", () => {
    expect(indexExports.CLAIM_TYPES).toBe(claimsExports.CLAIM_TYPES);
  });

  it("binds StellarCred namespace to the deduplicated implementations", () => {
    expect(StellarCred.hasClaim).toBe(claimsExports.hasClaim);
    expect(StellarCred.getClaims).toBe(claimsExports.getClaims);
    expect(StellarCred.configure).toBe(claimsExports.configure);
    expect(StellarCred.verifyPreset).toBe(claimsExports.verifyPreset);
  });

  it("shares configuration state between index.configure and claims.getConfig", () => {
    indexExports.configure({ registryId: "C_DEDUPE_TEST_REGISTRY", requestTimeoutMs: 5432 });
    const cfg = claimsExports.getConfig();
    expect(cfg.registryId).toBe("C_DEDUPE_TEST_REGISTRY");
    expect(cfg.requestTimeoutMs).toBe(5432);
    expect(claimsExports.isConfigured()).toBe(true);
  });
});
