import { describe, it, expect } from "vitest";
import {
  SCHEMA_PRESETS,
  buildJsonLdSchema,
  buildSamplePayload,
  parseJsonLdSchema,
  toSchemaSlug,
  validateSamplePayload,
  validateSchemaDraft,
  type CredentialSchemaDraft,
} from "../credential-schema";

describe("credential-schema library", () => {
  it("converts schema names into kebab-case slugs", () => {
    expect(toSchemaSlug("ProofOfFundsCredential")).toBe("proof-of-funds-credential");
    expect(toSchemaSlug("   ")).toBe("custom-credential");
  });

  it("validates all built-in presets cleanly", () => {
    for (const preset of SCHEMA_PRESETS) {
      const result = validateSchemaDraft(preset.draft);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    }
  });

  it("rejects invalid Soroban claimSymbol (>9 chars or invalid chars)", () => {
    const draft: CredentialSchemaDraft = {
      ...SCHEMA_PRESETS[0].draft,
      claimSymbol: "toolongclaimsymbol",
    };
    const result = validateSchemaDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "claimSymbol")).toBe(true);
  });

  it("detects duplicate attribute names and invalid range bounds", () => {
    const draft: CredentialSchemaDraft = {
      name: "TestCred",
      claimSymbol: "test",
      version: "1.0.0",
      description: "Test",
      defaultExpiryDays: 30,
      attributes: [
        {
          id: "a1",
          name: "score",
          type: "integer",
          required: true,
          description: "",
          zkConstraint: "range",
          constraintValue: "100",
          constraintMax: "50",
        },
        {
          id: "a2",
          name: "score",
          type: "string",
          required: false,
          description: "",
          zkConstraint: "minThreshold",
          constraintValue: "10",
        },
      ],
    };

    const result = validateSchemaDraft(draft);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("Duplicate attribute"))).toBe(true);
    expect(result.errors.some((e) => e.message.includes("cannot be greater than max"))).toBe(true);
    expect(
      result.errors.some((e) => e.message.includes("requires a numeric or date attribute type")),
    ).toBe(true);
  });

  it("builds W3C JSON-LD schema and round-trips through parseJsonLdSchema", () => {
    const original = SCHEMA_PRESETS[0].draft;
    const jsonLd = buildJsonLdSchema(original);

    expect(jsonLd["@context"][0]).toBe("https://www.w3.org/2018/credentials/v1");
    expect(jsonLd.type).toContain("VerifiableCredentialSchema");
    expect(jsonLd.type).toContain("StellarCredSchema");
    expect(jsonLd.stellarCred.claimSymbol).toBe("funds");
    expect(jsonLd.stellarCred.constraints).toHaveLength(2);
    expect(jsonLd.credentialSubject.required).toEqual(["balanceUsd", "accountVerified"]);

    const parsed = parseJsonLdSchema(JSON.stringify(jsonLd, null, 2));
    expect(parsed.ok).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.draft?.name).toBe(original.name);
    expect(parsed.draft?.claimSymbol).toBe(original.claimSymbol);
    expect(parsed.draft?.attributes).toHaveLength(original.attributes.length);
    expect(parsed.draft?.attributes[0].zkConstraint).toBe("minThreshold");
    expect(parsed.draft?.attributes[0].constraintValue).toBe("50000");
  });

  it("reports structured errors when parsing invalid JSON or incomplete JSON-LD", () => {
    const syntaxErr = parseJsonLdSchema("{ bad json");
    expect(syntaxErr.ok).toBe(false);
    expect(syntaxErr.errors[0].field).toBe("json");

    const missingFields = parseJsonLdSchema(JSON.stringify({ name: "OnlyName" }));
    expect(missingFields.ok).toBe(false);
    expect(missingFields.errors.some((e) => e.field === "@context")).toBe(true);
    expect(missingFields.errors.some((e) => e.field === "stellarCred")).toBe(true);
  });

  it("evaluates sample payloads against types and StellarCred ZK constraints", () => {
    const fundsDraft = SCHEMA_PRESETS[0].draft;
    const validSample = buildSamplePayload(fundsDraft);
    const passRes = validateSamplePayload(fundsDraft, JSON.stringify(validSample));
    expect(passRes.ok).toBe(true);
    expect(passRes.checks.every((c) => c.passed)).toBe(true);

    const failRes = validateSamplePayload(
      fundsDraft,
      JSON.stringify({ balanceUsd: 1000, accountVerified: false }),
    );
    expect(failRes.ok).toBe(false);
    expect(failRes.checks[0].passed).toBe(false);
    expect(failRes.checks[1].passed).toBe(false);
  });

  it("evaluates denylist and allowlist constraints properly", () => {
    const jurisdictionDraft = SCHEMA_PRESETS[2].draft;
    expect(validateSamplePayload(jurisdictionDraft, JSON.stringify({ countryCode: 276 })).ok).toBe(
      true,
    );
    expect(validateSamplePayload(jurisdictionDraft, JSON.stringify({ countryCode: 408 })).ok).toBe(
      false,
    );
  });
});
