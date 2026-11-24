import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "../credential";
import { bucketCredentials, EXPIRING_SOON_DAYS } from "./useCredentialBuckets";

const NOW = 1_800_000_000; // seconds
const DAY = 86_400;
const TTL = 90 * DAY; // expiry: "90 days"

function cred(commitment: string, provedAt?: number): Credential {
  return {
    type: "kyc",
    title: "KYC Complete",
    claim: "identity verified",
    issuer: "StellarCred Authority",
    issuerId: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2",
    holder: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    value: "1",
    salt: "2",
    commitment,
    sig: [],
    issuerPubX: [],
    issuerPubY: [],
    issuedAt: 0,
    expiry: "90 days",
    ...(provedAt === undefined ? {} : { provedAt }),
  };
}

/** A credential proved so that it has `daysLeft` days until its proof expires. */
const provedWith = (commitment: string, daysLeft: number) =>
  cred(commitment, NOW - TTL + daysLeft * DAY);

describe("bucketCredentials", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => vi.useRealTimers());

  it("puts every credential in exactly one section", () => {
    const creds = [
      cred("unproved"),
      provedWith("active", 30),
      provedWith("soon", 3),
      provedWith("expired", -1),
    ];
    const b = bucketCredentials(creds);

    expect(b.unproved.map((c) => c.commitment)).toEqual(["unproved"]);
    expect(b.activeProved.map((c) => c.commitment)).toEqual(["active"]);
    expect(b.expiringSoon.map((c) => c.commitment)).toEqual(["soon"]);
    expect(b.expired.map((c) => c.commitment)).toEqual(["expired"]);
  });

  it("sorts expiring-soon credentials soonest first", () => {
    const b = bucketCredentials([
      provedWith("five", 5),
      provedWith("one", 1),
      provedWith("three", 3),
    ]);
    expect(b.expiringSoon.map((c) => c.commitment)).toEqual(["one", "three", "five"]);
  });

  it("uses a 7-day window", () => {
    expect(EXPIRING_SOON_DAYS).toBe(7);
    const b = bucketCredentials([provedWith("edge", 7), provedWith("past-edge", 8)]);
    expect(b.expiringSoon.map((c) => c.commitment)).toEqual(["edge"]);
    expect(b.activeProved.map((c) => c.commitment)).toEqual(["past-edge"]);
  });

  it("returns empty sections for no credentials", () => {
    expect(bucketCredentials([])).toEqual({
      unproved: [],
      expiringSoon: [],
      activeProved: [],
      expired: [],
    });
  });
});
