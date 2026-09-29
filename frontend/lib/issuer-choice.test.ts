import { describe, it, expect } from "vitest";
import {
  eligibleIssuers,
  isProtocolAccepted,
  pickDefaultIssuer,
} from "./issuer-choice";
import type { RegisteredIssuer } from "./issuer-registry";
import type { CredentialType } from "./stellar";

function issuer(
  id: string,
  credentialTypes: CredentialType[],
  revoked = false,
): RegisteredIssuer {
  return {
    id,
    name: id,
    pubkeyHex: "00".repeat(64),
    credentialTypes,
    revoked,
  };
}

const AGE = issuer("GAGE", ["age", "kyc"]);
const KYC_ONLY = issuer("GKYC", ["kyc"]);
const REVOKED = issuer("GDEAD", ["age"], true);
const ALL = [AGE, KYC_ONLY, REVOKED];

describe("eligibleIssuers", () => {
  it("keeps only non-revoked issuers registered for the claim type", () => {
    expect(eligibleIssuers(ALL, "age").map((i) => i.id)).toEqual(["GAGE"]);
  });

  it("returns nothing when no claim type is selected", () => {
    expect(eligibleIssuers(ALL, null)).toEqual([]);
  });
});

describe("isProtocolAccepted", () => {
  it("accepts any issuer when the link sets no trusted-issuer gate", () => {
    expect(isProtocolAccepted("GAGE", undefined)).toBe(true);
  });

  it("accepts only listed issuers when the protocol restricts them", () => {
    expect(isProtocolAccepted("GAGE", ["GAGE", "GOTHER"])).toBe(true);
    expect(isProtocolAccepted("GKYC", ["GAGE"])).toBe(false);
  });

  it("rejects every issuer against an explicit empty list", () => {
    expect(isProtocolAccepted("GAGE", [])).toBe(false);
  });
});

describe("pickDefaultIssuer", () => {
  const ACME = issuer("GACME", ["age"]);

  it("prefers an issuer the protocol will accept", () => {
    expect(pickDefaultIssuer([AGE, ACME], ["GACME"])).toBe("GACME");
  });

  it("falls back to the first eligible issuer when none are accepted", () => {
    expect(pickDefaultIssuer([AGE, ACME], ["GNOTREGISTERED"])).toBe("GAGE");
  });

  it("returns nothing when no issuer is eligible", () => {
    expect(pickDefaultIssuer([], ["GACME"])).toBe("");
  });
});
