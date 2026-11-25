import { describe, expect, it } from "vitest";
import type { Credential } from "./credential";
import { buildDisclosureDiff, type DisclosureDiff } from "./disclosure-diff";
import { CREDENTIAL_TYPES, type CredentialType } from "./stellar";

const HOLDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ISSUER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";
const NOW = new Date("2026-11-22T12:00:00Z");

// Distinctive private material, so a leak into the shared column is easy to
// detect by substring search.
const SECRET_VALUE = "773311992288";
const SECRET_SALT = "0x5a17c0ffee5a17c0ffee";
const SECRET_SENIORITY = "4242";

function cred(type: CredentialType, overrides: Partial<Credential> = {}): Credential {
  return {
    type,
    title: `Title for ${type}`,
    claim: "claim",
    issuer: "StellarCred Authority",
    issuerId: ISSUER,
    holder: HOLDER,
    value: SECRET_VALUE,
    salt: SECRET_SALT,
    commitment: "0x1234567890abcdef1234567890abcdef",
    sig: [9, 8, 7, 6, 5],
    issuerPubX: [1],
    issuerPubY: [2],
    issuedAt: 1_700_000_000,
    expiry: "90 days",
    ...(type === "employment" ? { seniority: SECRET_SENIORITY } : {}),
    ...overrides,
  };
}

const keys = (items: DisclosureDiff["shared"]) => items.map((i) => i.key);

describe("buildDisclosureDiff", () => {
  it.each(CREDENTIAL_TYPES)("splits a %s credential into shared and private rows", (type) => {
    const diff = buildDisclosureDiff(cred(type), { now: NOW });

    expect(diff.title).toBe(`Title for ${type}`);
    expect(diff.shared.length).toBeGreaterThan(0);
    expect(diff.kept.length).toBeGreaterThan(0);
    expect(keys(diff.shared)).toEqual(
      expect.arrayContaining([
        "holder",
        "credential_type",
        "issuer",
        "claim",
        "commitment",
        "validity",
      ]),
    );
    expect(keys(diff.kept)).toEqual(expect.arrayContaining(["salt", "issuer_signature"]));

    // Keys are unique across both columns, so a row can't be in both.
    const all = [...keys(diff.shared), ...keys(diff.kept)];
    expect(new Set(all).size).toBe(all.length);
  });

  it.each(CREDENTIAL_TYPES)("never puts %s private material in the shared column", (type) => {
    const diff = buildDisclosureDiff(cred(type), { now: NOW });
    const shared = JSON.stringify(diff.shared);

    expect(shared).not.toContain(SECRET_VALUE);
    expect(shared).not.toContain(SECRET_SALT);
    expect(shared).not.toContain(SECRET_SENIORITY);
  });

  it.each(CREDENTIAL_TYPES)("gives %s private rows no value to render", (type) => {
    const diff = buildDisclosureDiff(cred(type), { now: NOW });

    for (const item of diff.kept) {
      expect(item.value).toBeUndefined();
      expect(item.label).not.toBe("");
      expect(item.detail).not.toBe("");
    }
    for (const item of diff.shared) {
      expect(item.value).toBeTruthy();
    }
  });

  it("keeps the date of birth private and discloses the proof date for age", () => {
    const diff = buildDisclosureDiff(cred("age", { claimParams: { threshold_years: "21" } }), {
      now: NOW,
    });

    expect(diff.kept.map((i) => i.label)).toContain("Date of birth");
    expect(diff.shared.find((i) => i.key === "current_date")?.value).toBe("2026-11-22");
    expect(diff.shared.find((i) => i.key === "claim")?.value).toBe("age ≥ 21");
  });

  it("uses the default threshold when the credential has no claim parameters", () => {
    const diff = buildDisclosureDiff(cred("income"), { now: NOW });

    expect(diff.shared.find((i) => i.key === "claim")?.value).toBe("income > $200,000");
    expect(diff.kept.map((i) => i.label)).toContain("Annual income (USD)");
  });

  it("discloses the jurisdiction rule but keeps the country private", () => {
    const diff = buildDisclosureDiff(
      cred("jurisdiction", { claimParams: { restricted: ["408", "364", "760"], mode: "1" } }),
      { now: NOW },
    );

    expect(diff.kept.map((i) => i.label)).toContain("Country (ISO numeric)");
    expect(diff.shared.find((i) => i.key === "restricted")?.value).toBe("3 countries");
    expect(diff.shared.find((i) => i.key === "claim")?.value).toBe("country in allowed list");
  });

  it("labels a jurisdiction credential without a list as using the default list", () => {
    const one = buildDisclosureDiff(
      cred("jurisdiction", { claimParams: { restricted: ["408"] } }),
      { now: NOW },
    );
    const none = buildDisclosureDiff(cred("jurisdiction"), { now: NOW });

    expect(one.shared.find((i) => i.key === "restricted")?.value).toBe("1 country");
    expect(none.shared.find((i) => i.key === "restricted")?.value).toBe("Default list");
  });

  it("keeps both employment status and seniority private", () => {
    const diff = buildDisclosureDiff(cred("employment", { claimParams: { threshold: "5" } }), {
      now: NOW,
    });

    expect(keys(diff.kept)).toEqual(expect.arrayContaining(["employment_status", "seniority"]));
    expect(diff.shared.find((i) => i.key === "claim")?.value).toBe("employed, seniority ≥ 5 yrs");
  });

  it("keeps the KYC identity secret private", () => {
    const diff = buildDisclosureDiff(cred("kyc"), { now: NOW });

    expect(diff.kept[0].label).toBe("Identity secret");
    expect(diff.shared.find((i) => i.key === "claim")?.value).toBe("identity verified");
  });

  it("only adds type-specific public inputs to circuits that have them", () => {
    for (const type of ["income", "funds", "accreditation", "employment", "kyc"] as const) {
      const shared = keys(buildDisclosureDiff(cred(type), { now: NOW }).shared);
      expect(shared).not.toContain("current_date");
      expect(shared).not.toContain("restricted");
    }
  });

  it("shows the connected wallet, truncated, and falls back to the credential holder", () => {
    const connected = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCZZZ";
    const withWallet = buildDisclosureDiff(cred("kyc"), { holder: connected, now: NOW });
    const withoutWallet = buildDisclosureDiff(cred("kyc"), { holder: "", now: NOW });
    const noHolder = buildDisclosureDiff(cred("kyc", { holder: "" }), { now: NOW });

    expect(withWallet.shared[0].value).toBe("GCCC…CZZZ");
    expect(withoutWallet.shared[0].value).toBe("GAAA…AWHF");
    expect(noHolder.shared[0].value).toBe("Not connected");
  });

  it("names the issuer and truncates the commitment and issuer address", () => {
    const diff = buildDisclosureDiff(cred("kyc"), { now: NOW });

    expect(diff.shared.find((i) => i.key === "issuer")?.value).toBe(
      "StellarCred Authority (GBBB…BHF2)",
    );
    expect(diff.shared.find((i) => i.key === "commitment")?.value).toBe("0x123456…cdef");
  });

  it("reports the proof validity from the credential expiry", () => {
    expect(
      buildDisclosureDiff(cred("kyc", { expiry: "30 days" }), { now: NOW }).shared.find(
        (i) => i.key === "validity",
      )?.value,
    ).toBe("30 days");
    expect(
      buildDisclosureDiff(cred("kyc", { expiry: "1 day" }), { now: NOW }).shared.find(
        (i) => i.key === "validity",
      )?.value,
    ).toBe("1 day");
  });
});
