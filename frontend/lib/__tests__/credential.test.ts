import { describe, it, expect } from "vitest";
import { parseCredential, type Credential } from "../credential";
import { CREDENTIAL_TYPES } from "../stellar";

/**
 * parseCredential is the trust boundary for imported / QR-scanned
 * credentials. These tests pin the structural validation: malformed input
 * must be rejected with a message naming the offending field before anything
 * is persisted, and well-formed credentials must pass through unchanged.
 */

// 64-byte compact secp256k1 signature, bytes in [0, 255].
const baseSig = Array.from({ length: 64 }, (_, i) => i % 256);
// 32-byte secp256k1 public-key coordinates.
const basePubX = Array.from({ length: 32 }, (_, i) => i % 256);
const basePubY = Array.from({ length: 32 }, (_, i) => (255 - i) % 256);

function validCredential(): Credential {
  return {
    type: "kyc",
    title: "KYC Complete",
    claim: "identity verified",
    issuer: "Onfido",
    issuerId: "issuer-1",
    holder: "GALICE",
    value: "1",
    salt: "0x0123",
    commitment: "0xdeadbeef",
    sig: baseSig,
    issuerPubX: basePubX,
    issuerPubY: basePubY,
    issuedAt: 1724000000,
    expiry: "90 days",
  };
}

/** Merge raw overrides into a valid credential JSON string. */
function serialize(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...validCredential(), ...overrides });
}

/** Serialize a valid credential with one or more top-level keys removed. */
function withoutField(...fields: (keyof Credential)[]): string {
  const copy: Record<string, unknown> = { ...validCredential() };
  for (const field of fields) delete copy[field];
  return JSON.stringify(copy);
}

function expectRejected(json: string, field: string): void {
  expect(() => parseCredential(json)).toThrowError(field);
}

describe("parseCredential", () => {
  it("accepts a structurally valid credential", () => {
    const cred = parseCredential(serialize({}));
    expect(cred.type).toBe("kyc");
    expect(cred.sig).toHaveLength(64);
    expect(cred.issuerPubX).toHaveLength(32);
    expect(cred.issuerPubY).toHaveLength(32);
  });

  it("accepts every supported credential type", () => {
    for (const type of CREDENTIAL_TYPES) {
      const { type: _t, ...rest } = validCredential();
      expect(() =>
        parseCredential(JSON.stringify({ ...rest, type })),
      ).not.toThrow();
    }
  });

  it("rejects an unknown type", () => {
    expectRejected(serialize({ type: "tax" }), "type");
  });

  it("rejects a missing type", () => {
    expectRejected(withoutField("type"), "type");
  });

  it("rejects empty value/salt/commitment", () => {
    expectRejected(serialize({ value: "" }), "value");
    expectRejected(serialize({ salt: "" }), "salt");
    expectRejected(serialize({ commitment: "" }), "commitment");
  });

  it("rejects non-numeric value/salt/commitment", () => {
    expectRejected(serialize({ value: "lots-of-money" }), "value");
    expectRejected(serialize({ salt: ["0x1"] }), "salt");
    expectRejected(serialize({ commitment: 1234 }), "commitment");
  });

  it("rejects a missing issuerId", () => {
    expectRejected(withoutField("issuerId"), "issuerId");
  });

  it("rejects a sig of the wrong length", () => {
    expectRejected(serialize({ sig: baseSig.slice(0, 63) }), "sig");
    expectRejected(serialize({ sig: [...baseSig, 7] }), "sig");
  });

  it("rejects a non-array sig", () => {
    expectRejected(serialize({ sig: "not-an-array" }), "sig");
  });

  it("rejects out-of-range or non-integer sig bytes", () => {
    expectRejected(serialize({ sig: [300, ...baseSig.slice(1)] }), "sig");
    expectRejected(serialize({ sig: [0, ...baseSig.slice(1), 1.5] }), "sig");
  });

  it("rejects issuerPubX/Y of the wrong length", () => {
    expectRejected(serialize({ issuerPubX: basePubX.slice(0, 31) }), "issuerPubX");
    expectRejected(serialize({ issuerPubY: [...basePubY, 0] }), "issuerPubY");
  });

  it("rejects out-of-range issuerPubX/Y bytes", () => {
    expectRejected(serialize({ issuerPubX: [-1, ...basePubX.slice(1)] }), "issuerPubX");
    expectRejected(serialize({ issuerPubY: [256, ...basePubY.slice(1)] }), "issuerPubY");
  });

  it("rejects an unparseable expiry", () => {
    expectRejected(serialize({ expiry: "" }), "expiry");
    expectRejected(serialize({ expiry: "never" }), "expiry");
  });

  it("accepts a numeric expiry", () => {
    expect(() => parseCredential(serialize({ expiry: "90 days" }))).not.toThrow();
  });

  it("rejects invalid JSON outright", () => {
    expect(() => parseCredential("{ not json")).toThrowError(SyntaxError);
  });

  it("does not silently persist — it throws instead of returning junk", () => {
    // A credential that only passes presence checks (e.g. empty sig array)
    // must be rejected rather than cast and stored.
    expectRejected(serialize({ sig: [] }), "sig");
  });
});