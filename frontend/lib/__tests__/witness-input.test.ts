import { describe, it, expect } from "vitest";
import {
  RESTRICTED_LEN,
  normalizeRestricted,
  validateWitnessCredential,
} from "../witness-input";

const bytes = (n: number, fill = 1) => Array.from({ length: n }, () => fill);

/** A credential with every circuit-shape field valid. */
function validCredential(overrides: Record<string, unknown> = {}) {
  return {
    value: "19000",
    salt: "0x" + "ab".repeat(31),
    commitment:
      "0x1e0f5c7a0b6a4d3e2c1b0a998877665544332211ffeeddccbbaa99887766554",
    sig: bytes(64),
    issuerPubX: bytes(32),
    issuerPubY: bytes(32, 2),
    ...overrides,
  };
}

describe("normalizeRestricted", () => {
  it("pads a short list to RESTRICTED_LEN with zeros", () => {
    expect(normalizeRestricted(["840", "364"])).toEqual([
      "840", "364", "0", "0", "0", "0", "0", "0",
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
    expect(validateWitnessCredential("kyc", validCredential({ value: "0", salt: "0x1f" }))).toBeNull();
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
    const modulus =
      "21888242871839275222246405745257275088548364400416034343698204186575808495617";
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

  it("accepts an income band when min and max are both integers", () => {
    const cred = validCredential({ claimParams: { min: "100000", max: "250000" } });
    expect(validateWitnessCredential("income", cred)).toBeNull();
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
