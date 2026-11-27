import { describe, it, expect } from "vitest";
import {
  IssuerClient,
  IssuerValidationError,
  previewCredential,
  validateIssueParams,
  parseIssueParams,
  parseIssuerClientOptions,
} from "./index";

const TEST_PRIVATE_KEY_64 = "01".repeat(32);

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    type: "kyc",
    holder: "GABCDEXAMPLEHOLDERADDRESS",
    issuerId: "test-issuer",
    issuerName: "Test Issuer",
    expiry: "90 days",
    attribute: {},
    ...overrides,
  };
}

describe("parseIssuerClientOptions", () => {
  it("accepts a valid 64-character hex private key", () => {
    expect(parseIssuerClientOptions({ privateKey: TEST_PRIVATE_KEY_64 })).toEqual({
      privateKey: TEST_PRIVATE_KEY_64,
    });
  });

  it("rejects missing, non-string, or malformed privateKey with IssuerValidationError", () => {
    for (const invalid of [null, undefined, {}, { privateKey: 12345 }, { privateKey: "abc" }]) {
      expect(() => parseIssuerClientOptions(invalid)).toThrow(IssuerValidationError);
    }
  });

  it("rejects unknown keys on IssuerClientOptions", () => {
    expect(() =>
      parseIssuerClientOptions({ privateKey: TEST_PRIVATE_KEY_64, extra: true }),
    ).toThrow(IssuerValidationError);
  });
});

describe("validateIssueParams — valid payloads", () => {
  it("accepts all 7 credential types with valid type-specific attributes", () => {
    const cases = [
      baseParams({ type: "kyc", attribute: {} }),
      baseParams({
        type: "age",
        attribute: { date_of_birth: "1995-06-15" },
        claimParams: { threshold_years: "18" },
      }),
      baseParams({
        type: "income",
        attribute: { income: "250000" },
        claimParams: { threshold: "200000" },
      }),
      baseParams({
        type: "jurisdiction",
        attribute: { country_code: "840" },
        claimParams: { restricted: ["408", "364"], mode: "0" },
      }),
      baseParams({
        type: "funds",
        attribute: { balance: "50000" },
        claimParams: { threshold: "10000" },
      }),
      baseParams({
        type: "accreditation",
        attribute: { net_worth: "1500000" },
        claimParams: { threshold: "1000000" },
      }),
      baseParams({
        type: "employment",
        attribute: { seniority: "5" },
        claimParams: { threshold: "3" },
      }),
      baseParams({
        type: "employment",
        attribute: {},
      }),
    ];

    for (const payload of cases) {
      const result = validateIssueParams(payload);
      expect(result.valid).toBe(true);
    }
  });

  it("accepts a non-negative integer Unix timestamp for expiry", () => {
    const result = validateIssueParams(baseParams({ expiry: 1_800_000_000 }));
    expect(result.valid).toBe(true);
  });
});

describe("validateIssueParams — top-level & metadata violations", () => {
  it("rejects non-object root payload", () => {
    const result = validateIssueParams("not-an-object");
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects unknown credential type with clear message", () => {
    const result = validateIssueParams(baseParams({ type: "passport" }));
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "type",
        message: expect.stringContaining("Unknown credential type"),
      }),
    );
  });

  it("rejects empty or non-string holder, issuerId, and issuerName", () => {
    const result = validateIssueParams(
      baseParams({ holder: "   ", issuerId: "", issuerName: 123 }),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain("holder");
    expect(paths).toContain("issuerId");
    expect(paths).toContain("issuerName");
  });

  it("rejects invalid expiry values", () => {
    for (const expiry of ["", "soon", -10, 12.5, null, {}]) {
      const result = validateIssueParams(baseParams({ expiry }));
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      expect(result.errors.some((e) => e.path === "expiry")).toBe(true);
    }
  });

  it("rejects unknown top-level keys", () => {
    const result = validateIssueParams(baseParams({ unexpectedField: "oops" }));
    expect(result.valid).toBe(false);
  });
});

describe("validateIssueParams — type-specific attribute violations", () => {
  it("rejects invalid age.date_of_birth formats, impossible dates, and pre-1970 dates", () => {
    for (const date_of_birth of [
      undefined,
      19950615,
      "06/15/1995",
      "not-a-date",
      "1990-02-30",
      "1969-12-31",
    ]) {
      const result = validateIssueParams(baseParams({ type: "age", attribute: { date_of_birth } }));
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      expect(result.errors.some((e) => e.path === "attribute.date_of_birth")).toBe(true);
    }
  });

  it("rejects invalid income.income values (number, negative, float, trailing text)", () => {
    for (const income of [undefined, 50000, "-100", "50000.50", "50000abc", ""]) {
      const result = validateIssueParams(baseParams({ type: "income", attribute: { income } }));
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      expect(result.errors.some((e) => e.path === "attribute.income")).toBe(true);
    }
  });

  it("rejects invalid jurisdiction.country_code values", () => {
    for (const country_code of [undefined, 840, "US", "-840", "840a"]) {
      const result = validateIssueParams(
        baseParams({ type: "jurisdiction", attribute: { country_code } }),
      );
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      expect(result.errors.some((e) => e.path === "attribute.country_code")).toBe(true);
    }
  });

  it("rejects invalid funds.balance values", () => {
    for (const balance of [undefined, 10000, "$10000", "-1", "10.5"]) {
      const result = validateIssueParams(baseParams({ type: "funds", attribute: { balance } }));
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      expect(result.errors.some((e) => e.path === "attribute.balance")).toBe(true);
    }
  });

  it("rejects invalid accreditation.net_worth values", () => {
    for (const net_worth of [undefined, 1000000, "-500", "1e6", "1000000.99"]) {
      const result = validateIssueParams(
        baseParams({ type: "accreditation", attribute: { net_worth } }),
      );
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      expect(result.errors.some((e) => e.path === "attribute.net_worth")).toBe(true);
    }
  });

  it("rejects invalid employment.seniority values that would break Noir poseidonCommit3", () => {
    for (const seniority of [5, "five", "-1", "2.5", ""]) {
      const result = validateIssueParams(
        baseParams({ type: "employment", attribute: { seniority } }),
      );
      expect(result.valid).toBe(false);
      if (result.valid) continue;
      expect(result.errors.some((e) => e.path === "attribute.seniority")).toBe(true);
    }
  });

  it("rejects unknown attribute keys for strict attribute schemas", () => {
    const result = validateIssueParams(
      baseParams({
        type: "income",
        attribute: { income: "100000", extra: "not-allowed" },
      }),
    );
    expect(result.valid).toBe(false);
  });

  it("rejects non-string values in kyc attributes", () => {
    const result = validateIssueParams(baseParams({ type: "kyc", attribute: { verified: true } }));
    expect(result.valid).toBe(false);
  });
});

describe("validateIssueParams — claimParams violations", () => {
  it("rejects malformed claimParams fields", () => {
    const result = validateIssueParams(
      baseParams({
        type: "jurisdiction",
        attribute: { country_code: "840" },
        claimParams: {
          threshold: "abc",
          threshold_years: "-1",
          mode: "2",
          restricted: ["840", "USA"],
        },
      }),
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain("claimParams.threshold");
    expect(paths).toContain("claimParams.threshold_years");
    expect(paths).toContain("claimParams.mode");
    expect(paths.some((p) => p.startsWith("claimParams.restricted"))).toBe(true);
  });
});

describe("SDK boundary enforcement in IssuerClient.issue and previewCredential", () => {
  it("parseIssueParams throws IssuerValidationError with human-readable message", () => {
    let caught: unknown;
    try {
      parseIssueParams(baseParams({ type: "income", attribute: { income: "not-a-number" } }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IssuerValidationError);
    const err = caught as IssuerValidationError;
    expect(err.message).toContain("attribute.income");
    expect(err.issues.length).toBeGreaterThan(0);
  });

  it("IssuerClient.issue rejects invalid attribute types before circuit proving", async () => {
    const issuer = new IssuerClient({ privateKey: TEST_PRIVATE_KEY_64 });
    await expect(
      issuer.issue({
        type: "employment",
        holder: "GABCDEXAMPLEHOLDERADDRESS",
        issuerId: "test-issuer",
        issuerName: "Test Issuer",
        expiry: "90 days",
        // @ts-expect-error — runtime boundary test for wrong attribute type
        attribute: { seniority: 5 },
      }),
    ).rejects.toThrow(IssuerValidationError);
  });

  it("previewCredential rejects invalid attribute types before circuit proving", async () => {
    await expect(
      previewCredential({
        type: "age",
        holder: "GABCDEXAMPLEHOLDERADDRESS",
        issuerId: "test-issuer",
        issuerName: "Test Issuer",
        expiry: "30 days",
        attribute: { date_of_birth: "not-a-date" },
      }),
    ).rejects.toThrow(IssuerValidationError);
  });
});
