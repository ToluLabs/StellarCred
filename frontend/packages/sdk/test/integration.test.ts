/**
 * Integration tests for @stellarcred/sdk.
 *
 * Runs against the live Stellar testnet deployment. Requires these env vars:
 *   SC_TEST_WALLET               – funded testnet wallet with at least one KYC proof
 *   STELLARCRED_REGISTRY_ID      – deployed ProofRegistry contract ID
 *
 * When env vars are absent, all tests skip gracefully — no failing CI on forks.
 *
 * Usage:
 *   pnpm test:integration
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  configure,
  hasClaim,
  getClaims,
  buildVerifyUrl,
  buildBadgeUrl,
  buildBadgeEmbedCode,
  CLAIM_TYPES,
} from "../src/index";
import { TEST_WALLET, REGISTRY_ID, RPC_URL } from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when a registry ID is available (allows read-only tests). */
const hasRegistry = !!REGISTRY_ID;

/**
 * Well-known barren address that has never interacted with StellarCred.
 * All claims should return false for this wallet.
 */
const BARREN_WALLET =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const skipMsg = (reason: string) => `SKIP: ${reason}`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("StellarCred SDK integration (testnet)", () => {
  beforeAll(() => {
    if (hasRegistry) {
      configure({
        registryId: REGISTRY_ID,
        rpcUrl: RPC_URL,
      });
    }
  });

  // ── hasClaim (false) ──────────────────────────────────────────────────

  describe("hasClaim", () => {
    it("returns false for a wallet with no proofs", async () => {
      if (!hasRegistry) return skipMsg("no registry ID configured");

      const result = await hasClaim(BARREN_WALLET, "kyc");
      expect(result).toBe(false);
    });

    it("returns false for a wallet with no proofs (any type)", async () => {
      if (!hasRegistry) return skipMsg("no registry ID configured");

      const results = await Promise.all(
        CLAIM_TYPES.map((t) => hasClaim(BARREN_WALLET, t)),
      );
      for (const r of results) {
        expect(r).toBe(false);
      }
    });
  });

  // ── hasClaim (true) — requires fixture wallet ─────────────────────────

  describe("hasClaim with fixture wallet", () => {
    it("returns true for a wallet that has a verified KYC proof", async () => {
      if (!TEST_WALLET) return skipMsg("SC_TEST_WALLET not set");
      if (!hasRegistry) return skipMsg("no registry ID configured");

      const result = await hasClaim(TEST_WALLET, "kyc");
      expect(result).toBe(true);
    });
  });

  // ── Threshold enforcement ─────────────────────────────────────────────

  describe("hasClaim with minThreshold", () => {
    it("returns true when minThreshold <= proved threshold (funds)", async () => {
      if (!TEST_WALLET) return skipMsg("SC_TEST_WALLET not set");
      if (!hasRegistry) return skipMsg("no registry ID configured");

      const hasFunds = await hasClaim(TEST_WALLET, "funds");
      if (!hasFunds) return skipMsg("fixture wallet has no funds proof");

      const result = await hasClaim(TEST_WALLET, "funds", {
        minThreshold: 5_000,
      });
      expect(result).toBe(true);
    });

    it("returns false when minThreshold > proved threshold (funds)", async () => {
      if (!TEST_WALLET) return skipMsg("SC_TEST_WALLET not set");
      if (!hasRegistry) return skipMsg("no registry ID configured");

      const hasFunds = await hasClaim(TEST_WALLET, "funds");
      if (!hasFunds) return skipMsg("fixture wallet has no funds proof");

      const result = await hasClaim(TEST_WALLET, "funds", {
        minThreshold: 999_999_999,
      });
      expect(result).toBe(false);
    });

    it("returns false for barren wallet even with minThreshold=0", async () => {
      if (!hasRegistry) return skipMsg("no registry ID configured");

      const result = await hasClaim(BARREN_WALLET, "funds", {
        minThreshold: 0,
      });
      expect(result).toBe(false);
    });
  });

  // ── getClaims ─────────────────────────────────────────────────────────

  describe("getClaims", () => {
    it("returns an empty array for a wallet with no proofs", async () => {
      if (!hasRegistry) return skipMsg("no registry ID configured");

      const claims = await getClaims(BARREN_WALLET);
      expect(claims).toEqual([]);
    });

    it("returns a non-empty array for a wallet with proofs", async () => {
      if (!TEST_WALLET) return skipMsg("SC_TEST_WALLET not set");
      if (!hasRegistry) return skipMsg("no registry ID configured");

      const claims = await getClaims(TEST_WALLET);
      expect(claims.length).toBeGreaterThan(0);

      for (const c of claims) {
        expect(c).toHaveProperty("type");
        expect(c).toHaveProperty("verifiedAt");
        expect(c).toHaveProperty("expiry");
        expect(typeof c.type).toBe("string");
        expect(CLAIM_TYPES).toContain(c.type);
        expect(typeof c.verifiedAt).toBe("number");
        expect(typeof c.expiry).toBe("number");
      }
    });
  });

  // ── buildVerifyUrl ────────────────────────────────────────────────────

  describe("buildVerifyUrl", () => {
    it("builds a URL with return_url and claim query params", () => {
      const url = buildVerifyUrl({
        returnUrl: "https://example.com/deposit",
        claim: "kyc",
      });

      expect(url).toContain("/verify?");
      expect(url).toContain(
        "return_url=https%3A%2F%2Fexample.com%2Fdeposit",
      );
      expect(url).toContain("claim=kyc");
    });

    it("appends threshold_years for age claims", () => {
      const url = buildVerifyUrl({
        returnUrl: "https://example.com/markets",
        claim: "age",
        claimParams: { threshold_years: "21" },
      });

      expect(url).toContain("threshold_years=21");
      expect(url).toContain("claim=age");
    });

    it("appends threshold for funds/income/accreditation claims", () => {
      const url = buildVerifyUrl({
        returnUrl: "https://example.com/vault",
        claim: "funds",
        claimParams: { threshold: "50000" },
      });

      expect(url).toContain("threshold=50000");
      expect(url).toContain("claim=funds");
    });

    it("appends restricted as comma-separated list for jurisdiction claims", () => {
      const url = buildVerifyUrl({
        returnUrl: "https://example.com/app",
        claim: "jurisdiction",
        claimParams: { restricted: ["840", "364"] },
      });

      expect(url).toContain("claim=jurisdiction");
      expect(url).toContain("restricted=840%2C364");
    });

    it("uses custom baseUrl when provided", () => {
      const url = buildVerifyUrl({
        returnUrl: "/dashboard",
        claim: "kyc",
        baseUrl: "https://custom-cred.xyz",
      });

      expect(url).toMatch(/^https:\/\/custom-cred\.xyz\/verify\?/);
    });

    it("accepts a relative return URL", () => {
      const url = buildVerifyUrl({
        returnUrl: "/deposit",
        claim: "kyc",
        baseUrl: "https://stellarcred.xyz",
      });

      expect(url).toContain("return_url=%2Fdeposit");
    });
  });

  // ── buildBadgeUrl & buildBadgeEmbedCode ───────────────────────────────────

  describe("buildBadgeUrl & buildBadgeEmbedCode", () => {
    it("constructs a valid embeddable badge URL", () => {
      const url = buildBadgeUrl({
        wallet: BARREN_WALLET,
        claim: "kyc",
        theme: "dark",
        baseUrl: "https://stellarcred.xyz",
      });

      expect(url).toContain("https://stellarcred.xyz/badge");
      expect(url).toContain(`wallet=${BARREN_WALLET}`);
      expect(url).toContain("claim=kyc");
      expect(url).toContain("theme=dark");
    });

    it("generates correct iframe embed HTML", () => {
      const embed = buildBadgeEmbedCode({
        wallet: BARREN_WALLET,
        claim: "funds",
        compact: true,
        baseUrl: "https://stellarcred.xyz",
      });

      expect(embed).toContain("<iframe");
      expect(embed).toContain("src=\"https://stellarcred.xyz/badge?wallet=");
      expect(embed).toContain("compact=1");
      expect(embed).toContain("width=\"180\"");
      expect(embed).toContain("height=\"36\"");
    });
  });
});

