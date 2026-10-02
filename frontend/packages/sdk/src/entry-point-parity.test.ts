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
import * as fromCapabilities from "./capabilities";
import * as fromChallenge from "./challenge";
import * as fromErrors from "./errors";

// ── Claim-checking functions (sourced from claims.ts) ────────────────────────

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
  "IndexerError",
] as const;

// Errors exports (sourced from errors.ts) - issue #404
const ERRORS_EXPORTS = [
  "RpcError",
  "ContractError",
  "ContractErrorCode",
  "parseContractError",
] as const;

// ── Challenge functions (sourced from challenge.ts) ──────────────────────────

const CHALLENGE_EXPORTS = [
  "createWalletChallenge",
  "verifyWalletSignature",
  "verifyWalletClaim",
] as const;

// ── Capability-descriptor functions (sourced from capabilities.ts, #639) ─────

const CAPABILITIES_EXPORTS = [
  "bootstrap",
  "fetchCapabilities",
  "validateCapabilitiesDescriptor",
] as const;

describe("entry-point parity (issue #609 / #522)", () => {
  beforeEach(() => {
    fromClaims.resetConfig();
  });

  // ── claims.ts exports re-exported identically by index.ts ─────────────────

  for (const name of CLAIMS_EXPORTS) {
    it(`index.ts re-exports the same ${name} reference as claims.ts`, () => {
      const fromIndexValue = (fromIndex as Record<string, unknown>)[name];
      const fromClaimsValue = (fromClaims as Record<string, unknown>)[name];

      expect(fromIndexValue).toBeDefined();
      expect(fromClaimsValue).toBeDefined();
      expect(fromIndexValue).toBe(fromClaimsValue);
    });
  }

  // ── challenge.ts exports re-exported identically by index.ts ──────────────

  for (const name of CHALLENGE_EXPORTS) {
    it(`index.ts re-exports the same ${name} reference as challenge.ts`, () => {
      const fromIndexValue = (fromIndex as Record<string, unknown>)[name];
      const fromChallengeValue = (fromChallenge as Record<string, unknown>)[name];

      expect(fromIndexValue).toBeDefined();
      expect(fromChallengeValue).toBeDefined();
      expect(fromIndexValue).toBe(fromChallengeValue);
    });
  }

  // ── capabilities.ts exports re-exported identically by index.ts ───────────

  for (const name of CAPABILITIES_EXPORTS) {
    it(`index.ts re-exports the same ${name} reference as capabilities.ts`, () => {
      const fromIndexValue = (fromIndex as Record<string, unknown>)[name];
      const fromCapabilitiesValue = (fromCapabilities as Record<string, unknown>)[name];

      expect(fromIndexValue).toBeDefined();
      expect(fromCapabilitiesValue).toBeDefined();
      expect(fromIndexValue).toBe(fromCapabilitiesValue);
    });
  }

  // ── StellarCred namespace holds same references ────────────────────────────
  // â”€â”€ StellarCred namespace holds same references â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // ── errors.ts exports re-exported identically by index.ts (issue #404) ────

  for (const name of ERRORS_EXPORTS) {
    it(`index.ts re-exports the same ${name} reference as errors.ts`, () => {
      const fromIndexValue = (fromIndex as Record<string, unknown>)[name];
      const fromErrorsValue = (fromErrors as Record<string, unknown>)[name];

      expect(fromIndexValue).toBeDefined();
      expect(fromErrorsValue).toBeDefined();
      expect(fromIndexValue).toBe(fromErrorsValue);
    });
  }

  // ── StellarCred namespace holds same references ──────────────────────────

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
    expect(ns.IndexerError).toBe(fromClaims.IndexerError);
  });

  it("StellarCred namespace members are the same references as challenge.ts exports", () => {
    const ns = fromIndex.StellarCred;

    expect(ns.createWalletChallenge).toBe(fromChallenge.createWalletChallenge);
    expect(ns.verifyWalletSignature).toBe(fromChallenge.verifyWalletSignature);
    expect(ns.verifyWalletClaim).toBe(fromChallenge.verifyWalletClaim);
  });

  it("StellarCred namespace members are the same references as capabilities.ts exports", () => {
    const ns = fromIndex.StellarCred;

    expect(ns.bootstrap).toBe(fromCapabilities.bootstrap);
    expect(ns.fetchCapabilities).toBe(fromCapabilities.fetchCapabilities);
    expect(ns.validateCapabilitiesDescriptor).toBe(
      fromCapabilities.validateCapabilitiesDescriptor,
    );
  it("StellarCred namespace members are the same references as errors.ts exports", () => {
    const ns = fromIndex.StellarCred;

    expect(ns.RpcError).toBe(fromErrors.RpcError);
    expect(ns.ContractError).toBe(fromErrors.ContractError);
    expect(ns.ContractErrorCode).toBe(fromErrors.ContractErrorCode);
    expect(ns.parseContractError).toBe(fromErrors.parseContractError);
  });

  it("default export equals the StellarCred named export", () => {
    expect(fromIndex.default).toBe(fromIndex.StellarCred);
  });

  it("configure() call propagates to getConfig() — single config object", () => {
    fromIndex.configure({ registryId: "C_PARITY_TEST", requestTimeoutMs: 1234 });
    const cfg = fromClaims.getConfig();
    expect(cfg.registryId).toBe("C_PARITY_TEST");
    expect(cfg.requestTimeoutMs).toBe(1234);
  });
});
