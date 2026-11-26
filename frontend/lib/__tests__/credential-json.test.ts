import { describe, expect, it } from "vitest";
import { parseCredentialDocument, serializeCredentialDocument } from "../credential-json";

const credential = {
  type: "kyc",
  title: "KYC Complete",
  claim: "identity verified",
  issuer: "Test issuer",
  issuerId: "test-issuer",
  holder: "GABCDEXAMPLEHOLDERADDRESS",
  value: "0x12",
  salt: "0x34",
  commitment: "0x56",
  sig: Array(64).fill(1),
  issuerPubX: Array(32).fill(2),
  issuerPubY: Array(32).fill(3),
  issuedAt: 1,
  expiry: "90 days",
  extension: { retained: true },
};

describe("credential JSON helpers", () => {
  it("round trips a credential array without changing credential fields", () => {
    const parsed = parseCredentialDocument(JSON.stringify([credential]));
    expect(parsed).toEqual([credential]);
    expect(JSON.parse(serializeCredentialDocument(parsed))).toEqual([credential]);
  });

  it("accepts a single credential and rejects encrypted backup envelopes", () => {
    expect(parseCredentialDocument(JSON.stringify(credential))).toEqual(credential);
    expect(() =>
      parseCredentialDocument(JSON.stringify({ version: 3, ciphertext: "..." })),
    ).toThrow(/Import them in the app with the backup passphrase/);
  });

  it("rejects malformed credential entries using the app parser", () => {
    expect(() => parseCredentialDocument(JSON.stringify([{ type: "unsupported" }]))).toThrow(
      /type must be one of/,
    );
  });
});
