import { describe, it, expect } from "vitest";
import { parseVerifyParams } from "./verifyParams";

describe("parseVerifyParams", () => {
  it("treats a plain /verify visit as self-service (no validation, no lock)", () => {
    const r = parseVerifyParams({});
    expect(r.ok).toBe(true);
    expect(r.isVerificationLink).toBe(false);
    expect(r.requiredClaim).toBeNull();
    expect(r.returnUrl).toBeUndefined();
  });

  it("allows a Persona resume link (?inquiry-id) as self-service", () => {
    const r = parseVerifyParams({ inquiry_id: "inq_abc123" });
    expect(r.ok).toBe(true);
    expect(r.isVerificationLink).toBe(false);
    expect(r.inquiryId).toBe("inq_abc123");
  });

  it("returns a missing-return-url error when a claim is present but no return_url", () => {
    const r = parseVerifyParams({ claim: "kyc" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("missing_return_url");
    expect(r.error?.title).toMatch(/missing its return URL/i);
  });

  it("returns a bad-claim error for an unknown claim type", () => {
    const r = parseVerifyParams({
      return_url: "/apps/lendfi",
      claim: "party-pass",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("bad_claim");
    expect(r.error?.title).toMatch(/party-pass/i);
  });

  it("returns a bad-threshold error for a malformed numeric threshold", () => {
    const r = parseVerifyParams({
      return_url: "/apps/fundvault",
      claim: "funds",
      threshold: "lots-of-money",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("bad_threshold");
    expect(r.error?.detail).toMatch(/lots-of-money/);
  });

  it("returns a bad-threshold error for a negative age threshold", () => {
    const r = parseVerifyParams({
      return_url: "/apps/agegate",
      claim: "age",
      threshold_years: "-18",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("bad_threshold");
  });

  it("returns a bad-restricted error for non-numeric country codes", () => {
    const r = parseVerifyParams({
      return_url: "/apps/borderfi",
      claim: "jurisdiction",
      restricted: "840,neverland",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("bad_restricted");
  });

  it("returns a bad-return-url error for an insecure / malformed return_url", () => {
    const r = parseVerifyParams({
      return_url: "javascript:alert(1)",
      claim: "kyc",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("bad_return_url");
  });

  it("accepts a well-formed verification link and exposes the locked claim + params", () => {
    const r = parseVerifyParams({
      return_url: "/apps/agegate",
      claim: "age",
      threshold_years: "21",
    });
    expect(r.ok).toBe(true);
    expect(r.isVerificationLink).toBe(true);
    expect(r.requiredClaim).toBe("age");
    expect(r.claimParams).toEqual({ threshold_years: "21" });
    expect(r.returnUrl).toBe("/apps/agegate");
  });

  it("normalises a jurisdiction restricted list to sorted clean codes", () => {
    const r = parseVerifyParams({
      return_url: "/apps/borderfi",
      claim: "jurisdiction",
      restricted: "364,840",
    });
    expect(r.ok).toBe(true);
    expect(r.claimParams?.restricted).toEqual(["364", "840"]);
  });

  it("omits non-applicable threshold params for binary claims", () => {
    const r = parseVerifyParams({
      return_url: "/apps/lendfi",
      claim: "kyc",
      threshold: "50000",
    });
    expect(r.ok).toBe(true);
    expect(r.claimParams?.threshold).toBeUndefined();
    expect(r.claimParams).toEqual({});
  });
});