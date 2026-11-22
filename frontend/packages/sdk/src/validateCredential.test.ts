// @vitest-environment node

import { describe, it, expect } from "vitest";
import {
  CREDENTIAL_TYPES,
  CredentialValidationError,
  assertValidCredential,
  parseCredentialJson,
  validateCredential,
} from "./validateCredential";
import { StellarCred } from "./index";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ISSUER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

function validCredential(overrides: Record<string, unknown> = {}) {
  return {
    type: "age",
    title: "Age Verified",
    claim: "age ≥ 18",
    issuer: "StellarCred Authority",
    issuerId: ISSUER,
    holder: WALLET,
    value: "9300",
    salt: "0xabc123",
    commitment: "0xdeadbeef",
    sig: Array.from({ length: 64 }, () => 1),
    issuerPubX: Array.from({ length: 32 }, () => 2),
    issuerPubY: Array.from({ length: 32 }, () => 3),
    issuedAt: 1_700_000_000,
    expiry: "90 days",
    ...overrides,
  };
}

function errorPaths(result: ReturnType<typeof validateCredential>): string[] {
  return result.valid ? [] : result.errors.map((issue) => issue.path);
}

describe("validateCredential", () => {
  it("accepts a well-formed credential and returns it unchanged", () => {
    const credential = validCredential();

    const result = validateCredential(credential);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.credential).toBe(credential);
    expect(result.credential.type).toBe("age");
  });

  it("accepts employment credentials with tenure and claim params", () => {
    const result = validateCredential(
      validCredential({
        type: "employment",
        seniority: "5",
        claimParams: { threshold_years: "3" },
      }),
    );

    expect(result.valid).toBe(true);
  });

  it("rejects every missing required field and names it", () => {
    const result = validateCredential({});

    expect(result.valid).toBe(false);
    const paths = errorPaths(result);
    for (const field of [
      "type",
      "title",
      "claim",
      "issuer",
      "issuerId",
      "holder",
      "value",
      "salt",
      "commitment",
      "sig",
      "issuerPubX",
      "issuerPubY",
      "issuedAt",
      "expiry",
    ]) {
      expect(paths).toContain(field);
    }
  });

  it("rejects non-object input with a root error", () => {
    const result = validateCredential("not-an-object");

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toEqual([{ path: "", message: "Credential must be a JSON object." }]);
  });

  it("rejects an unknown credential type and lists the supported ones", () => {
    const result = validateCredential(validCredential({ type: "passport" }));

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "type",
        message: expect.stringContaining("passport"),
      }),
    );
    expect(result.errors[0].message).toContain(CREDENTIAL_TYPES.join(", "));
  });

  it("rejects non-field value/salt/commitment strings", () => {
    const result = validateCredential(
      validCredential({
        value: "not a number",
        salt: "",
        commitment: "0xzzz",
      }),
    );

    expect(result.valid).toBe(false);
    const paths = errorPaths(result);
    expect(paths).toContain("value");
    expect(paths).toContain("salt");
    expect(paths).toContain("commitment");
  });

  it("rejects incorrectly sized signature and public-key arrays", () => {
    const result = validateCredential(
      validCredential({
        sig: [1, 2, 3],
        issuerPubX: Array.from({ length: 32 }, () => 256),
        issuerPubY: "not-an-array",
      }),
    );

    expect(result.valid).toBe(false);
    const errors = result.valid ? [] : result.errors;
    expect(errors).toContainEqual(
      expect.objectContaining({
        path: "sig",
        message: expect.stringContaining("exactly 64 bytes"),
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        path: "issuerPubX",
        message: expect.stringContaining("[0, 255]"),
      }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        path: "issuerPubY",
        message: expect.stringContaining("array of 32 bytes"),
      }),
    );
  });

  it("rejects a non-integer issuedAt and an unparseable expiry", () => {
    const result = validateCredential(validCredential({ issuedAt: 1.5, expiry: "soon" }));

    expect(result.valid).toBe(false);
    const paths = errorPaths(result);
    expect(paths).toContain("issuedAt");
    expect(paths).toContain("expiry");
  });

  it("rejects malformed optional claimParams and seniority", () => {
    const result = validateCredential(
      validCredential({
        type: "employment",
        seniority: "five",
        claimParams: { threshold_years: 3, restricted: ["840", 44] },
      }),
    );

    expect(result.valid).toBe(false);
    const paths = errorPaths(result);
    expect(paths).toContain("seniority");
    expect(paths).toContain("claimParams.threshold_years");
    expect(paths).toContain("claimParams.restricted");
  });
});

describe("parseCredentialJson", () => {
  it("parses and validates JSON text", () => {
    const result = parseCredentialJson(JSON.stringify(validCredential()));

    expect(result.valid).toBe(true);
  });

  it("returns a validation error for malformed JSON instead of throwing", () => {
    const result = parseCredentialJson("{not-json");

    expect(result).toEqual({
      valid: false,
      errors: [{ path: "", message: "Invalid JSON." }],
    });
  });
});

describe("assertValidCredential", () => {
  it("returns normally for a valid credential", () => {
    expect(() => assertValidCredential(validCredential())).not.toThrow();
  });

  it("throws CredentialValidationError with the issue list", () => {
    let caught: unknown;
    try {
      assertValidCredential(validCredential({ issuerId: "" }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CredentialValidationError);
    const error = caught as CredentialValidationError;
    expect(error.issues).toContainEqual(expect.objectContaining({ path: "issuerId" }));
    expect(error.message).toContain("issuerId");
  });
});

describe("entry-point exports", () => {
  it("exposes the validator on the StellarCred namespace", () => {
    expect(StellarCred.validateCredential).toBe(validateCredential);
    expect(StellarCred.parseCredentialJson).toBe(parseCredentialJson);
    expect(StellarCred.assertValidCredential).toBe(assertValidCredential);
    expect(StellarCred.CredentialValidationError).toBe(CredentialValidationError);
  });
});
