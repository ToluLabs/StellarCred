// entry-point-parity.test.ts
//
// Regression guard for issue #609 / #522 (SDK claims.ts / index.ts duplication).
//
// Asserts that every public function exported by `index.ts` is IDENTICAL
// (===, same function reference) to the one exported by `claims.ts` (or
// `challenge.ts` for wallet-challenge APIs). If someone adds a duplicate
// implementation in index.ts instead of delegating to the source module,
// these tests will fail immediately.

import { describe, it, expect, beforeEach } from "vitest";

import * as fromIndex from "./index";
import * as fromClaims from "./claims";
import * as fromChallenge from "./challenge";

// â”€â”€ Claim-checking functions (sourced from claims.ts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CLAIMS_EXPORTS = [
  "configure",
  "healthCheck",
  "isConfigured",
  "hasClaim",
  "getClaim",
  "getClaimRecord",
  "checkClaimStatus",
  "hasClaims",
  "verifyPreset",
  "getClaims",
  "buildVerifyUrl",
  "buildBadgeUrl",
  "buildBadgeEmbedCode",
  "parseReturnParams",
  "watchClaim",
  "withRetry",
  "getConfig",
  "resetConfig",
  "CLAIM_TYPES",
  "TimeoutError",
  "ConfigError",
  "InvalidAddressError",
  "RpcError",
  "IndexerError",
] as const;

// â”€â”€ Challenge functions (sourced from challenge.ts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CHALLENGE_EXPORTS = [
  "createWalletChallenge",
  "verifyWalletSignature",
  "verifyWalletClaim",
] as const;

describe("entry-point parity (issue #609 / #522)", () => {
  beforeEach(() => {
    fromClaims.resetConfig();
  });

  // â”€â”€ claims.ts exports re-exported identically by index.ts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  for (const name of CLAIMS_EXPORTS) {
    it(`index.ts re-exports the same ${name} reference as claims.ts`, () => {
      const fromIndexValue = (fromIndex as Record<string, unknown>)[name];
      const fromClaimsValue = (fromClaims as Record<string, unknown>)[name];

      expect(fromIndexValue).toBeDefined();
      expect(fromClaimsValue).toBeDefined();
      expect(fromIndexValue).toBe(fromClaimsValue);
    });
  }

  // â”€â”€ challenge.ts exports re-exported identically by index.ts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  for (const name of CHALLENGE_EXPORTS) {
    it(`index.ts re-exports the same ${name} reference as challenge.ts`, () => {
      const fromIndexValue = (fromIndex as Record<string, unknown>)[name];
      const fromChallengeValue = (fromChallenge as Record<string, unknown>)[name];

      expect(fromIndexValue).toBeDefined();
      expect(fromChallengeValue).toBeDefined();
      expect(fromIndexValue).toBe(fromChallengeValue);
    });
  }

  // â”€â”€ StellarCred namespace holds same references â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it("StellarCred namespace members are the same references as claims.ts exports", () => {
    const ns = fromIndex.StellarCred;

    expect(ns.configure).toBe(fromClaims.configure);
    expect(ns.healthCheck).toBe(fromClaims.healthCheck);
    expect(ns.isConfigured).toBe(fromClaims.isConfigured);
    expect(ns.hasClaim).toBe(fromClaims.hasClaim);
    expect(ns.getClaim).toBe(fromClaims.getClaim);
    expect(ns.getClaimRecord).toBe(fromClaims.getClaimRecord);
    expect(ns.checkClaimStatus).toBe(fromClaims.checkClaimStatus);
    expect(ns.hasClaims).toBe(fromClaims.hasClaims);
    expect(ns.verifyPreset).toBe(fromClaims.verifyPreset);
    expect(ns.getClaims).toBe(fromClaims.getClaims);
    expect(ns.buildVerifyUrl).toBe(fromClaims.buildVerifyUrl);
    expect(ns.buildBadgeUrl).toBe(fromClaims.buildBadgeUrl);
    expect(ns.buildBadgeEmbedCode).toBe(fromClaims.buildBadgeEmbedCode);
    expect(ns.parseReturnParams).toBe(fromClaims.parseReturnParams);
    expect(ns.watchClaim).toBe(fromClaims.watchClaim);
    expect(ns.withRetry).toBe(fromClaims.withRetry);
    expect(ns.TimeoutError).toBe(fromClaims.TimeoutError);
    expect(ns.ConfigError).toBe(fromClaims.ConfigError);
    expect(ns.InvalidAddressError).toBe(fromClaims.InvalidAddressError);
    expect(ns.RpcError).toBe(fromClaims.RpcError);
    expect(ns.IndexerError).toBe(fromClaims.IndexerError);
  });

  it("StellarCred namespace members are the same references as challenge.ts exports", () => {
    const ns = fromIndex.StellarCred;

    expect(ns.createWalletChallenge).toBe(fromChallenge.createWalletChallenge);
    expect(ns.verifyWalletSignature).toBe(fromChallenge.verifyWalletSignature);
    expect(ns.verifyWalletClaim).toBe(fromChallenge.verifyWalletClaim);
  });

  it("default export equals the StellarCred named export", () => {
    expect(fromIndex.default).toBe(fromIndex.StellarCred);
  });

  it("configure() call propagates to getConfig() â€” single config object", () => {
    fromIndex.configure({ registryId: "C_PARITY_TEST", requestTimeoutMs: 1234 });
    const cfg = fromClaims.getConfig();
    expect(cfg.registryId).toBe("C_PARITY_TEST");
    expect(cfg.requestTimeoutMs).toBe(1234);
  });
});
