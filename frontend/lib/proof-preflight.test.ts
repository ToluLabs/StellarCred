import { describe, expect, it } from "vitest";
import { getProofPreflightWarnings } from "./proof-preflight";
import type { Credential } from "./credential";

const base = {
  title: "Test credential",
  claim: "test",
  issuer: "Issuer",
  issuerId: "GISSUER",
  holder: "GHOLDER",
  salt: "salt",
  commitment: "commitment",
  sig: [],
  issuerPubX: [],
  issuerPubY: [],
  issuedAt: 1_700_000_000,
  expiry: "90 days",
} satisfies Omit<Credential, "type" | "value">;

function credential(overrides: Partial<Credential>): Credential {
  return { ...base, type: "income", value: "100", ...overrides } as Credential;
}

describe("getProofPreflightWarnings", () => {
  it("warns when a numeric value is below the requested threshold", () => {
    const warnings = getProofPreflightWarnings(
      credential({ claimParams: { threshold: "500" } }),
      new Date(1_700_000_001_000),
    );
    expect(warnings.map((warning) => warning.code)).toContain("below-threshold");
    expect(warnings[0]?.message).toMatch(/100.*500/);
  });

  it("warns when jurisdiction is denylisted", () => {
    const warnings = getProofPreflightWarnings(
      credential({ type: "jurisdiction", value: "840", claimParams: { restricted: ["840", "364"] } }),
      new Date(1_700_000_001_000),
    );
    expect(warnings).toEqual([{ code: "jurisdiction-denied", message: expect.stringMatching(/840/) }]);
  });

  it("warns when the credential itself has expired", () => {
    const warnings = getProofPreflightWarnings(
      credential({ issuedAt: 1_700_000_000, expiry: "1 days" }),
      new Date((1_700_000_000 + 86_400 + 1) * 1000),
    );
    expect(warnings.map((warning) => warning.code)).toContain("credential-expired");
  });

  it("checks age against the requested years threshold", () => {
    const warnings = getProofPreflightWarnings(
      credential({ type: "age", value: "2010-06-15", claimParams: { threshold_years: "18" } }),
      new Date("2026-06-14T00:00:00Z"),
    );
    expect(warnings.map((warning) => warning.code)).toContain("below-threshold");
  });
});
