import { describe, it, expect, beforeEach } from "vitest";
import {
  buildVerifyUrl,
  type BuildVerifyUrlOptions,
  type BuildVerifyUrlClaimParams,
  type KycVerifyUrlOptions,
  type AgeVerifyUrlOptions,
  type ThresholdVerifyUrlOptions,
  type JurisdictionVerifyUrlOptions,
} from "../buildVerifyUrl";
import { configure, resetConfig } from "../claims";

describe("buildVerifyUrl helper & typed options", () => {
  beforeEach(() => {
    resetConfig();
  });

  describe("validation & error handling", () => {
    it("throws when returnUrl is missing", () => {
      // @ts-expect-error testing missing returnUrl
      expect(() => buildVerifyUrl({})).toThrow(/returnUrl/);
    });

    it("throws when returnUrl is empty string or only whitespace", () => {
      expect(() => buildVerifyUrl({ returnUrl: "" })).toThrow(/returnUrl/);
      expect(() => buildVerifyUrl({ returnUrl: "   " })).toThrow(/returnUrl/);
    });

    it("throws when expiresInMinutes is not positive", () => {
      expect(() =>
        buildVerifyUrl({
          returnUrl: "https://app.xyz/callback",
          expiresInMinutes: 0,
        }),
      ).toThrow(/expiresInMinutes must be a positive number/);

      expect(() =>
        buildVerifyUrl({
          returnUrl: "https://app.xyz/callback",
          expiresInMinutes: -10,
        }),
      ).toThrow(/expiresInMinutes must be a positive number/);

      expect(() =>
        buildVerifyUrl({
          returnUrl: "https://app.xyz/callback",
          expiresInMinutes: NaN,
        }),
      ).toThrow(/expiresInMinutes must be a positive number/);
    });
  });

  describe("URL generation & parameters", () => {
    it("builds basic KYC URL with return_url", () => {
      const opts: KycVerifyUrlOptions = {
        returnUrl: "https://app.xyz/deposit",
        claim: "kyc",
      };
      const url = new URL(buildVerifyUrl(opts));

      expect(url.origin).toBe("https://stellarcred.xyz");
      expect(url.pathname).toBe("/verify");
      expect(url.searchParams.get("return_url")).toBe("https://app.xyz/deposit");
      expect(url.searchParams.get("claim")).toBe("kyc");
    });

    it("supports relative return URLs", () => {
      const url = new URL(
        buildVerifyUrl({
          returnUrl: "/dashboard",
          claim: "kyc",
        }),
      );

      expect(url.searchParams.get("return_url")).toBe("/dashboard");
    });

    it("respects custom baseUrl option", () => {
      const url = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/callback",
          baseUrl: "https://auth.custom-domain.org",
        }),
      );

      expect(url.origin).toBe("https://auth.custom-domain.org");
      expect(url.pathname).toBe("/verify");
    });

    it("uses configured baseUrl from SDK configure()", () => {
      configure({ baseUrl: "https://staging.stellarcred.xyz" });

      const url = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/callback",
        }),
      );

      expect(url.origin).toBe("https://staging.stellarcred.xyz");
    });

    it("supports multiple claims", () => {
      const opts: BuildVerifyUrlOptions = {
        returnUrl: "https://app.xyz/profile",
        claims: ["kyc", "age", "funds"],
      };
      const url = new URL(buildVerifyUrl(opts));

      expect(url.searchParams.get("claims")).toBe("kyc,age,funds");
    });

    it("supports wallet and state parameters", () => {
      const wallet = "GD5JUTWG55NKQE5N6WEXYV5C5Z4S3E43G26N5EAI5O5V6B2F3D4E5F6G";
      const url = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/account",
          wallet,
          state: "csrf_session_789",
        }),
      );

      expect(url.searchParams.get("wallet")).toBe(wallet);
      expect(url.searchParams.get("state")).toBe("csrf_session_789");
    });

    it("supports trustedIssuers restriction", () => {
      const trustedIssuers = [
        "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVWGS",
        "GCFXHS4GMXBYRBAPOH2KZIGNDQBMV5DNZD5WT6VHGQ3M7N2TRB664BXO",
      ];
      const url = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/gate",
          claim: "kyc",
          trustedIssuers,
        }),
      );

      expect(url.searchParams.get("trusted_issuers")).toBe(trustedIssuers.join(","));
    });
  });

  describe("claimParams variations", () => {
    it("handles age threshold with threshold_years (number and string)", () => {
      const urlNum = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/markets",
          claim: "age",
          claimParams: { threshold_years: 21 },
        } satisfies AgeVerifyUrlOptions),
      );

      expect(urlNum.searchParams.get("threshold_years")).toBe("21");
      expect(urlNum.searchParams.get("param_threshold_years")).toBe("21");

      const urlStr = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/markets",
          claim: "age",
          claimParams: { threshold_years: "18" },
        }),
      );

      expect(urlStr.searchParams.get("threshold_years")).toBe("18");
      expect(urlStr.searchParams.get("param_threshold_years")).toBe("18");
    });

    it("handles financial claims with threshold (number and string)", () => {
      const urlFunds = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/vault",
          claim: "funds",
          claimParams: { threshold: 50000 },
        } satisfies ThresholdVerifyUrlOptions),
      );

      expect(urlFunds.searchParams.get("threshold")).toBe("50000");
      expect(urlFunds.searchParams.get("param_threshold")).toBe("50000");

      const urlIncome = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/loan",
          claim: "income",
          claimParams: { threshold: "100000" },
        } satisfies ThresholdVerifyUrlOptions),
      );

      expect(urlIncome.searchParams.get("threshold")).toBe("100000");
    });

    it("handles jurisdiction claims with restricted country codes (array and string)", () => {
      const urlArr = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/trade",
          claim: "jurisdiction",
          claimParams: { restricted: ["840", "364"] },
        } satisfies JurisdictionVerifyUrlOptions),
      );

      expect(urlArr.searchParams.get("restricted")).toBe("840,364");
      expect(urlArr.searchParams.get("param_restricted")).toBe("840,364");

      const urlStr = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/trade",
          claim: "jurisdiction",
          claimParams: { restricted: "840,364" },
        }),
      );

      expect(urlStr.searchParams.get("restricted")).toBe("840,364");
    });

    it("forwards mode and custom claim parameters", () => {
      const claimParams: BuildVerifyUrlClaimParams = {
        threshold: 25000,
        mode: "strict",
        custom_flag: "true",
      };

      const url = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/pool",
          claim: "funds",
          claimParams,
        }),
      );

      expect(url.searchParams.get("mode")).toBe("strict");
      expect(url.searchParams.get("custom_flag")).toBe("true");
    });
  });

  describe("expiry and single-use security parameters", () => {
    it("sets exp timestamp based on expiresInMinutes", () => {
      const beforeSec = Math.floor(Date.now() / 1000);
      const url = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/auth",
          expiresInMinutes: 30,
        }),
      );
      const afterSec = Math.floor(Date.now() / 1000);

      const exp = Number(url.searchParams.get("exp"));
      expect(exp).toBeGreaterThanOrEqual(beforeSec + 1800);
      expect(exp).toBeLessThanOrEqual(afterSec + 1800);
    });

    it("generates unique URL-safe jti tokens when singleUse is true", () => {
      const url1 = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/auth",
          singleUse: true,
        }),
      );
      const url2 = new URL(
        buildVerifyUrl({
          returnUrl: "https://app.xyz/auth",
          singleUse: true,
        }),
      );

      const jti1 = url1.searchParams.get("jti");
      const jti2 = url2.searchParams.get("jti");

      expect(jti1).toBeTruthy();
      expect(jti2).toBeTruthy();
      expect(jti1).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(jti1).not.toBe(jti2);
    });
  });
});
