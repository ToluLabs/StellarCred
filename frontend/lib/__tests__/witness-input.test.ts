import { describe, it, expect } from "vitest";
import {
  FIELD_MODULUS,
  RESTRICTED_LEN,
  U64_MAX,
  isProverResourceExhaustion,
  normalizeRestricted,
  prepareAcvmInputs,
  sanitizeScalarString,
  validateCircuitInputs,
  validateWitnessCredential,
  type CircuitAbi,
} from "../witness-input";
import ageCircuit from "../../public/circuits/age.json";
import jurisdictionCircuit from "../../public/circuits/jurisdiction.json";

const bytes = (n: number, fill = 1) => Array.from({ length: n }, () => fill);

/** A credential with every circuit-shape field valid. */
function validCredential(overrides: Record<string, unknown> = {}) {
  return {
    value: "19000",
    salt: "0x" + "ab".repeat(31),
    commitment: "0x1e0f5c7a0b6a4d3e2c1b0a998877665544332211ffeeddccbbaa99887766554",
    sig: bytes(64),
    issuerPubX: bytes(32),
    issuerPubY: bytes(32, 2),
    ...overrides,
  };
}

describe("normalizeRestricted", () => {
  it("pads a short list to RESTRICTED_LEN with zeros", () => {
    expect(normalizeRestricted(["840", "364"])).toEqual([
      "840",
      "364",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
  });

  it("leaves a full-length list untouched", () => {
    const full = Array.from({ length: RESTRICTED_LEN }, (_, i) => String(i));
    expect(normalizeRestricted(full)).toEqual(full);
  });
});

describe("validateWitnessCredential", () => {
  it("accepts a well-formed credential of every type", () => {
    for (const type of ["kyc", "age", "income", "funds", "accreditation", "jurisdiction"]) {
      expect(validateWitnessCredential(type, validCredential())).toBeNull();
    }
  });

  it("accepts decimal and 0x-hex field strings", () => {
    expect(
      validateWitnessCredential("kyc", validCredential({ value: "0", salt: "0x1f" })),
    ).toBeNull();
  });

  it.each([
    ["value", "credential.value"],
    ["salt", "credential.salt"],
    ["commitment", "credential.commitment"],
  ])("rejects a missing %s", (field, reported) => {
    const cred = validCredential({ [field]: undefined });
    expect(validateWitnessCredential("kyc", cred)).toEqual({
      field: reported,
      message: "is required",
    });
  });

  it("rejects a non-numeric field string", () => {
    const err = validateWitnessCredential("kyc", validCredential({ value: "not-a-number" }));
    expect(err?.field).toBe("credential.value");
  });

  it("rejects a field at or above the BN254 modulus", () => {
    const modulus = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
    const err = validateWitnessCredential("kyc", validCredential({ salt: modulus }));
    expect(err).toEqual({
      field: "credential.salt",
      message: "exceeds the BN254 field modulus",
    });
  });

  it("rejects a signature that is not exactly 64 bytes", () => {
    const err = validateWitnessCredential("kyc", validCredential({ sig: bytes(63) }));
    expect(err).toEqual({
      field: "credential.sig",
      message: "must be exactly 64 bytes, received 63",
    });
  });

  it.each([
    ["issuerPubX", "credential.issuerPubX"],
    ["issuerPubY", "credential.issuerPubY"],
  ])("rejects a %s that is not exactly 32 bytes", (field, reported) => {
    const err = validateWitnessCredential("kyc", validCredential({ [field]: bytes(33) }));
    expect(err?.field).toBe(reported);
  });

  it("rejects a byte outside [0,255] and names its index", () => {
    const sig = bytes(64);
    sig[7] = 256;
    expect(validateWitnessCredential("kyc", validCredential({ sig }))).toEqual({
      field: "credential.sig[7]",
      message: "must be an integer between 0 and 255",
    });
  });

  it("rejects a non-integer byte", () => {
    const sig = bytes(64);
    sig[0] = 1.5;
    expect(validateWitnessCredential("kyc", validCredential({ sig }))?.field).toBe(
      "credential.sig[0]",
    );
  });

  it("rejects a sig that is not an array", () => {
    const err = validateWitnessCredential("kyc", validCredential({ sig: "deadbeef" }));
    expect(err).toEqual({
      field: "credential.sig",
      message: "must be an array of 64 bytes",
    });
  });

  it("rejects a non-integer age threshold", () => {
    const cred = validCredential({ claimParams: { threshold_years: "21.5" } });
    expect(validateWitnessCredential("age", cred)).toEqual({
      field: "credential.claimParams.threshold_years",
      message: "must be a non-negative integer",
    });
  });

  it("accepts an integer threshold given as a number", () => {
    const cred = validCredential({ claimParams: { threshold: 50000 } });
    expect(validateWitnessCredential("funds", cred)).toBeNull();
  });

  it("ignores an omitted threshold — the route applies a default", () => {
    expect(validateWitnessCredential("income", validCredential())).toBeNull();
  });

  it("rejects claimParams that are not an object", () => {
    const cred = validCredential({ claimParams: ["nope"] });
    expect(validateWitnessCredential("age", cred)).toEqual({
      field: "credential.claimParams",
      message: "must be an object",
    });
  });

  it("rejects a non-numeric restricted entry", () => {
    const cred = validCredential({ claimParams: { restricted: ["840", "US"] } });
    expect(validateWitnessCredential("jurisdiction", cred)).toEqual({
      field: "credential.claimParams.restricted[1]",
      message: "must be a numeric ISO 3166-1 country code (0-999)",
    });
  });

  it("rejects a restricted list longer than RESTRICTED_LEN rather than truncating it", () => {
    const restricted = Array.from({ length: RESTRICTED_LEN + 1 }, () => "840");
    const cred = validCredential({ claimParams: { restricted } });
    expect(validateWitnessCredential("jurisdiction", cred)).toEqual({
      field: "credential.claimParams.restricted",
      message: `accepts at most ${RESTRICTED_LEN} entries, received ${RESTRICTED_LEN + 1}`,
    });
  });

  it("accepts a short restricted list — the route pads it", () => {
    const cred = validCredential({ claimParams: { restricted: ["840", "364"] } });
    expect(validateWitnessCredential("jurisdiction", cred)).toBeNull();
  });

  it("validates an unknown type as kyc", () => {
    const err = validateWitnessCredential("made-up", validCredential({ sig: bytes(10) }));
    expect(err?.field).toBe("credential.sig");
  });
});

// ── #803 — large inputs must be rejected before they reach the prover ─────
// The u64-typed circuits range-constrain their value/threshold inputs, so an
// oversized value can never produce a witness: it crashes witness generation
// deep inside ACVM. These checks turn that prover crash into a precise 400.

describe("u64 circuit inputs (#803)", () => {
  const overMax = (U64_MAX + 1n).toString();

  it("accepts a value exactly at the u64 max", () => {
    expect(
      validateWitnessCredential("income", validCredential({ value: U64_MAX.toString() })),
    ).toBeNull();
    expect(
      validateWitnessCredential("funds", validCredential({ value: U64_MAX.toString() })),
    ).toBeNull();
  });

  it.each(["age", "income", "funds", "accreditation", "jurisdiction", "employment"])(
    "rejects a %s credential value above u64 max",
    (type) => {
      const err = validateWitnessCredential(type, validCredential({ value: overMax }));
      expect(err?.field).toBe("credential.value");
      expect(err?.message).toContain("64-bit");
    },
  );

  it("rejects a u64 value given as an over-max hex string", () => {
    // 2^64 in hex — fits the field modulus but not u64.
    const err = validateWitnessCredential("age", validCredential({ value: "0x10000000000000000" }));
    expect(err?.field).toBe("credential.value");
    expect(err?.message).toContain("64-bit");
  });

  it("rejects an age threshold above u64 max", () => {
    const cred = validCredential({ claimParams: { threshold_years: overMax } });
    const err = validateWitnessCredential("age", cred);
    expect(err?.field).toBe("credential.claimParams.threshold_years");
    expect(err?.message).toContain("64-bit");
  });

  it("accepts a threshold exactly at the u64 max", () => {
    const cred = validCredential({ claimParams: { threshold: U64_MAX.toString() } });
    expect(validateWitnessCredential("funds", cred)).toBeNull();
  });

  it("rejects employment seniority above u64 max", () => {
    const err = validateWitnessCredential("employment", validCredential({ seniority: overMax }));
    expect(err?.field).toBe("credential.seniority");
    expect(err?.message).toContain("64-bit");
  });

  it("rejects an aggregate age_date_of_birth above u64 max", () => {
    const agg = {
      kyc_secret: "1",
      kyc_salt: "2",
      kyc_sig: bytes(64),
      kyc_commitment: "3",
      kyc_issuer_x: bytes(32),
      kyc_issuer_y: bytes(32, 2),
      age_date_of_birth: overMax,
      age_salt: "4",
      age_sig: bytes(64),
      age_commitment: "5",
      age_issuer_x: bytes(32),
      age_issuer_y: bytes(32, 2),
      age_threshold_years: "18",
      num_credentials: "2",
    };
    const err = validateWitnessCredential("aggregate", agg);
    expect(err?.field).toBe("credential.age_date_of_birth");
  });

  it("still accepts an arbitrary Field secret for kyc (no u64 cap)", () => {
    const fieldMax =
      21888242871839275222246405745257275088548364400416034343698204186575808495616n.toString(); // modulus - 1
    expect(validateWitnessCredential("kyc", validCredential({ value: fieldMax }))).toBeNull();
  });

  it("cuts off a pathologically long field string before parsing it", () => {
    const err = validateWitnessCredential("kyc", validCredential({ value: "9".repeat(1000) }));
    expect(err).toEqual({
      field: "credential.value",
      message: "exceeds the BN254 field modulus",
    });
  });
});

describe("isProverResourceExhaustion (#803)", () => {
  it.each([
    "memory allocation failed",
    "Array buffer allocation failed",
    "out of memory",
    "RuntimeError: unreachable",
  ])("recognises %j as prover memory exhaustion", (message) => {
    expect(isProverResourceExhaustion(message)).toBe(true);
  });

  it.each([
    "Attempt to multiply with overflow",
    "Failed to decode u64",
    "Witness generation failed: constraint false",
    "",
  ])("does not treat %j as memory exhaustion", (message) => {
    expect(isProverResourceExhaustion(message)).toBe(false);
  });
});

// ── Pre-flight sanitation & ABI validation ───────────────────────────────────

describe("additional credential pre-flight checks", () => {
  it("rejects unsafe JS numbers (precision loss / scientific notation)", () => {
    expect(validateWitnessCredential("kyc", validCredential({ value: 1e21 }))?.field).toBe(
      "credential.value",
    );
    expect(
      validateWitnessCredential("income", validCredential({ value: Number.MAX_SAFE_INTEGER + 1 }))
        ?.field,
    ).toBe("credential.value");
  });

  it("requires age_date_of_birth and age_threshold_years for aggregate credentials", () => {
    const baseAgg = {
      kyc_secret: "1",
      kyc_salt: "2",
      kyc_sig: bytes(64),
      kyc_commitment: "3",
      kyc_issuer_x: bytes(32),
      kyc_issuer_y: bytes(32, 2),
      age_date_of_birth: "10000",
      age_salt: "4",
      age_sig: bytes(64),
      age_commitment: "5",
      age_issuer_x: bytes(32),
      age_issuer_y: bytes(32, 2),
      age_threshold_years: "18",
      num_credentials: "2",
    };
    expect(validateWitnessCredential("aggregate", baseAgg)).toBeNull();
    expect(
      validateWitnessCredential("aggregate", { ...baseAgg, age_date_of_birth: undefined }),
    ).toEqual({
      field: "credential.age_date_of_birth",
      message: "is required",
    });
    expect(
      validateWitnessCredential("aggregate", { ...baseAgg, age_threshold_years: undefined }),
    ).toEqual({
      field: "credential.age_threshold_years",
      message: "is required",
    });
  });

  it("validates jurisdiction mode (0 = denylist, 1 = allowlist)", () => {
    expect(
      validateWitnessCredential("jurisdiction", validCredential({ claimParams: { mode: "0" } })),
    ).toBeNull();
    expect(
      validateWitnessCredential("jurisdiction", validCredential({ claimParams: { mode: "1" } })),
    ).toBeNull();
    expect(
      validateWitnessCredential("jurisdiction", validCredential({ claimParams: { mode: "2" } })),
    ).toEqual({
      field: "credential.claimParams.mode",
      message: 'must be "0" (denylist) or "1" (allowlist)',
    });
  });
});

describe("sanitizeScalarString", () => {
  it("trims whitespace and normalizes uppercase 0X hex prefix", () => {
    expect(sanitizeScalarString("  42  ")).toBe("42");
    expect(sanitizeScalarString(" 0X1a2B ")).toBe("0x1a2B");
  });
});

describe("prepareAcvmInputs & validateCircuitInputs", () => {
  it("validates and sanitizes inputs against the real age circuit ABI", () => {
    const res = prepareAcvmInputs(ageCircuit.abi as CircuitAbi, {
      date_of_birth: " 19000 ",
      salt: " 0X1a ",
      sig: bytes(64),
      commitment: "12345",
      issuer_x: bytes(32),
      issuer_y: bytes(32, 2),
      current_date: 20000,
      threshold_years: "18",
      unexpected_extra_key: "should-be-stripped",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.inputs.date_of_birth).toBe("19000");
      expect(res.inputs.salt).toBe("26");
      expect(res.inputs.current_date).toBe("20000");
      expect(res.inputs.sig).toEqual(bytes(64));
      expect("unexpected_extra_key" in res.inputs).toBe(false);
    }
  });

  it("rejects wrong array dimensions against the real jurisdiction circuit ABI", () => {
    const errors = validateCircuitInputs(jurisdictionCircuit.abi as CircuitAbi, {
      country_code: "840",
      salt: "1",
      sig: bytes(63), // wrong length (expected 64)
      commitment: "2",
      issuer_x: bytes(32),
      issuer_y: bytes(32, 2),
      restricted: ["840", "364"], // wrong length (expected 8)
      mode: "0",
    });

    expect(errors.map((e) => e.field)).toEqual(["sig", "restricted"]);
    expect(errors[0].message).toContain("length 64");
    expect(errors[1].message).toContain("length 8");
  });

  it("validates boolean, signed integers, strings, structs, tuples, and nested arrays", () => {
    const syntheticAbi: CircuitAbi = {
      parameters: [
        { name: "flag", type: { kind: "boolean" } },
        { name: "delta", type: { kind: "integer", sign: "signed", width: 8 } },
        { name: "tag", type: { kind: "string", length: 4 } },
        {
          name: "matrix",
          type: {
            kind: "array",
            length: 2,
            type: {
              kind: "array",
              length: 2,
              type: { kind: "integer", sign: "unsigned", width: 8 },
            },
          },
        },
        {
          name: "pair",
          type: {
            kind: "tuple",
            fields: [{ kind: "field" }, { kind: "boolean" }],
          },
        },
        {
          name: "meta",
          type: {
            kind: "struct",
            path: "Meta",
            fields: [{ name: "id", type: { kind: "integer", sign: "unsigned", width: 32 } }],
          },
        },
      ],
    };

    const ok = prepareAcvmInputs(syntheticAbi, {
      flag: "true",
      delta: "-128",
      tag: "abcd",
      matrix: [
        [1, 2],
        [3, 4],
      ],
      pair: ["10", false],
      meta: { id: 42 },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.inputs.flag).toBe(true);
      expect(ok.inputs.delta).toBe("-128");
      expect(ok.inputs.meta).toEqual({ id: "42" });
    }

    const bad = validateCircuitInputs(syntheticAbi, {
      flag: "maybe",
      delta: "-129", // below i8 min (-128)
      tag: "too-long",
      matrix: [[1, 2], [3]], // nested dimension mismatch
      pair: [FIELD_MODULUS.toString(), true], // field out of bounds
      meta: { id: -1 }, // negative u32
    });

    expect(bad.map((e) => e.field)).toEqual([
      "flag",
      "delta",
      "tag",
      "matrix[1]",
      "pair[0]",
      "meta.id",
    ]);
  });
});
