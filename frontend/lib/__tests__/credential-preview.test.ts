// Unit tests for lib/credential-preview.ts — issue #617.
//
// These are pure-function tests: no network, no DOM. They cover the claim
// label builder and the attribute formatter for every credential type.

import { describe, it, expect } from "vitest";
import { buildClaimLabel, formatAttributeDisplay } from "../credential-preview";

describe("buildClaimLabel", () => {
  it("kyc returns fixed label", () => {
    expect(buildClaimLabel("kyc")).toBe("identity verified");
  });

  it("age uses default threshold 18 when no claimParams", () => {
    expect(buildClaimLabel("age")).toBe("age ≥ 18");
  });

  it("age uses custom threshold_years from claimParams", () => {
    expect(buildClaimLabel("age", { threshold_years: "21" })).toBe("age ≥ 21");
  });

  it("income uses default threshold $200,000", () => {
    expect(buildClaimLabel("income")).toBe("income > $200,000");
  });

  it("income uses custom threshold from claimParams", () => {
    expect(buildClaimLabel("income", { threshold: "500000" })).toBe("income > $500,000");
  });

  it("funds uses default threshold $10,000", () => {
    expect(buildClaimLabel("funds")).toBe("balance > $10,000");
  });

  it("funds uses custom threshold from claimParams", () => {
    expect(buildClaimLabel("funds", { threshold: "50000" })).toBe("balance > $50,000");
  });

  it("accreditation uses default threshold $1,000,000", () => {
    expect(buildClaimLabel("accreditation")).toBe("net worth ≥ $1,000,000");
  });

  it("accreditation uses custom threshold from claimParams", () => {
    expect(buildClaimLabel("accreditation", { threshold: "2000000" })).toBe(
      "net worth ≥ $2,000,000",
    );
  });

  it("employment uses default seniority 3 years", () => {
    expect(buildClaimLabel("employment")).toBe("employed, seniority ≥ 3 yrs");
  });

  it("employment uses custom threshold from claimParams", () => {
    expect(buildClaimLabel("employment", { threshold: "5" })).toBe(
      "employed, seniority ≥ 5 yrs",
    );
  });

  it("jurisdiction returns denylist label by default (mode undefined)", () => {
    expect(buildClaimLabel("jurisdiction")).toBe("country not restricted");
  });

  it("jurisdiction returns denylist label for mode '0'", () => {
    expect(buildClaimLabel("jurisdiction", { mode: "0" })).toBe("country not restricted");
  });

  it("jurisdiction returns allowlist label for mode '1'", () => {
    expect(buildClaimLabel("jurisdiction", { mode: "1" })).toBe("country in allowed list");
  });
});

describe("formatAttributeDisplay", () => {
  it("returns null when attributeLabel is null (kyc)", () => {
    expect(formatAttributeDisplay("kyc", "", null)).toBeNull();
  });

  it("returns null when attributeValue is empty", () => {
    expect(formatAttributeDisplay("age", "", "Date of birth")).toBeNull();
  });

  it("age returns the date string as-is", () => {
    expect(formatAttributeDisplay("age", "1995-06-15", "Date of birth")).toBe("1995-06-15");
  });

  it("income formats as USD", () => {
    expect(formatAttributeDisplay("income", "250000", "Annual income (USD)")).toBe("$250,000");
  });

  it("funds formats as USD", () => {
    expect(formatAttributeDisplay("funds", "50000", "Balance (USD)")).toBe("$50,000");
  });

  it("accreditation formats as USD", () => {
    expect(formatAttributeDisplay("accreditation", "1000000", "Net worth (USD)")).toBe(
      "$1,000,000",
    );
  });

  it("employment formats as years (singular)", () => {
    expect(formatAttributeDisplay("employment", "1", "Seniority (years)")).toBe("1 year");
  });

  it("employment formats as years (plural)", () => {
    expect(formatAttributeDisplay("employment", "5", "Seniority (years)")).toBe("5 years");
  });

  it("jurisdiction returns raw value (ISO numeric code)", () => {
    expect(formatAttributeDisplay("jurisdiction", "276", "Country (ISO numeric)")).toBe("276");
  });
});
