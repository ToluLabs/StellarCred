import { describe, it, expect } from "vitest";
import { normalizeAttributes, ATTRIBUTE_FIELD_BY_TYPE } from "./attribute-normalizer";
import { CREDENTIAL_TYPES } from "./stellar";

describe("normalizeAttributes", () => {
  // ── Credential-specific shorthand mappings ──────────────────────────────
  // These mirror attributeToValue in packages/issuer/src/index.ts: the
  // shorthand `attribute` string lands on the field the circuit commits to.
  it("maps the age shorthand onto date_of_birth", () => {
    expect(normalizeAttributes("age", "1995-06-15", {})).toEqual({
      date_of_birth: "1995-06-15",
    });
  });

  it("maps the income shorthand onto income", () => {
    expect(normalizeAttributes("income", "250000", {})).toEqual({
      income: "250000",
    });
  });

  it("maps the jurisdiction shorthand onto country_code", () => {
    expect(normalizeAttributes("jurisdiction", "840", {})).toEqual({
      country_code: "840",
    });
  });

  it("maps the employment shorthand onto seniority", () => {
    expect(normalizeAttributes("employment", "5", {})).toEqual({
      seniority: "5",
    });
  });

  it("maps the funds shorthand onto balance", () => {
    expect(normalizeAttributes("funds", "50000", {})).toEqual({
      balance: "50000",
    });
  });

  it("maps the accreditation shorthand onto net_worth", () => {
    expect(normalizeAttributes("accreditation", "1500000", {})).toEqual({
      net_worth: "1500000",
    });
  });

  it("applies no mapping for kyc (no user-supplied attribute)", () => {
    expect(normalizeAttributes("kyc", "anything", {})).toEqual({});
  });

  it("preserves unrelated explicit attributes alongside the mapped field", () => {
    expect(normalizeAttributes("age", "1995-06-15", { custom: "x" })).toEqual({
      date_of_birth: "1995-06-15",
      custom: "x",
    });
  });

  // ── Precedence ──────────────────────────────────────────────────────────
  // The routes historically used `??=`: an explicit `attributes` entry always
  // wins over the shorthand (e.g. the issuer UI's explicit balance or an
  // attribute field the client already filled).
  it("lets an explicit attributes entry win over the shorthand", () => {
    expect(normalizeAttributes("age", "1995-06-15", { date_of_birth: "1990-01-01" })).toEqual({
      date_of_birth: "1990-01-01",
    });
  });

  it("does not mutate the input attributes object", () => {
    const input = { custom: "x" };
    const out = normalizeAttributes("age", "1995-06-15", input);
    expect(input).toEqual({ custom: "x" });
    expect(out).not.toBe(input);
  });

  // ── Invalid / absent input ──────────────────────────────────────────────
  // Normalization runs before the routes validate credential types, so it
  // must never throw on hostile or incomplete input — unknown types pass
  // through untouched and let the caller's type check reject them.
  it("passes attributes through unchanged when the type is unknown", () => {
    expect(normalizeAttributes("not_a_real_type", "whatever", { custom: "x" })).toEqual({
      custom: "x",
    });
  });

  it("applies no shorthand when the type is missing", () => {
    expect(normalizeAttributes(undefined, "1995-06-15", {})).toEqual({});
  });

  it("applies no shorthand when the attribute is missing", () => {
    expect(normalizeAttributes("age", undefined, {})).toEqual({});
  });

  it("returns a copy of attributes when both shorthand inputs are absent", () => {
    expect(normalizeAttributes(undefined, undefined, { custom: "x" })).toEqual({
      custom: "x",
    });
  });

  it("preserves ??= semantics for an empty-string shorthand (issuer rejects it later)", () => {
    // The historical inline logic was `attributes[field] ??= attribute`, so
    // "" is a present value and gets set; attributeToValue in the issuer
    // package is what rejects it (e.g. `!dob`), not this layer.
    expect(normalizeAttributes("age", "", {})).toEqual({ date_of_birth: "" });
  });

  it("does not resolve Object.prototype members for hostile type strings", () => {
    expect(normalizeAttributes("constructor", "x", {})).toEqual({});
    expect(normalizeAttributes("toString", "x", {})).toEqual({});
    expect(normalizeAttributes("__proto__", "x", {})).toEqual({});
  });

  // ── Coverage guard: a new credential type forces a single table update ──
  it("declares a mapping entry for every credential type", () => {
    for (const type of CREDENTIAL_TYPES) {
      expect(ATTRIBUTE_FIELD_BY_TYPE).toHaveProperty(type);
    }
  });

  it("maps every attribute-bearing type to the field its circuit commits to", () => {
    const expected: Record<string, string | undefined> = {
      kyc: undefined,
      age: "date_of_birth",
      income: "income",
      jurisdiction: "country_code",
      funds: "balance",
      accreditation: "net_worth",
      employment: "seniority",
    };
    for (const type of CREDENTIAL_TYPES) {
      expect(ATTRIBUTE_FIELD_BY_TYPE[type]).toBe(expected[type]);
    }
  });
});
