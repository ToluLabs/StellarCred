import { describe, expect, it } from "vitest";
import type { Credential } from "../credential";
import { validateClaimInputs } from "../proof-validation";

const walletKey = Array(32).fill(7);

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    type: "funds",
    title: "Proof of Funds",
    claim: "balance > $10,000",
    issuer: "Test issuer",
    issuerId: "test-issuer",
    holder: "GABCDEXAMPLEHOLDERADDRESS",
    value: "20000",
    salt: "0x01",
    commitment: "0x1234",
    sig: Array(64).fill(0),
    issuerPubX: walletKey,
    issuerPubY: Array(32).fill(9),
    issuedAt: 1,
    expiry: "90 days",
    ...overrides,
  };
}

function makeFields(credential: Credential, threshold = "10000"): string[] {
  return [
    credential.commitment,
    ...credential.issuerPubX.map(String),
    ...credential.issuerPubY.map(String),
    threshold,
  ];
}

describe("validateClaimInputs", () => {
  it("accepts public inputs matching the credential and default funds threshold", () => {
    const credential = makeCredential();
    expect(validateClaimInputs(credential, makeFields(credential))).toEqual([]);
  });

  it("rejects a proof using a different claim threshold", () => {
    const credential = makeCredential({ claimParams: { threshold: "15000" } });
    expect(validateClaimInputs(credential, makeFields(credential, "10000"))).toContain(
      "Proof threshold does not match the credential claim policy (15000).",
    );
  });

  it("rejects mismatched issuer keys and input counts with actionable diagnostics", () => {
    const credential = makeCredential();
    const fields = makeFields(credential);
    fields[1] = "8";
    expect(validateClaimInputs(credential, fields)).toContain(
      "Proof issuer public key does not match the credential issuer key.",
    );
    expect(validateClaimInputs(credential, fields.slice(1))[0]).toMatch(
      /Expected 66 public inputs/,
    );
  });

  it("checks jurisdiction list padding and mode against credential policy", () => {
    const credential = makeCredential({
      type: "jurisdiction",
      claimParams: { restricted: ["840", "364"], mode: "1" },
    });
    const fields = [
      credential.commitment,
      ...credential.issuerPubX.map(String),
      ...credential.issuerPubY.map(String),
      "840",
      "364",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "1",
    ];
    expect(validateClaimInputs(credential, fields)).toEqual([]);
    fields[73] = "0";
    expect(validateClaimInputs(credential, fields)).toContain(
      "Proof jurisdiction mode does not match the credential claim policy (0=denylist, 1=allowlist).",
    );
  });
});
