import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadCredentials,
  saveCredential,
  type Credential,
} from "@/lib/credential";

describe("credential store encryption", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("stores credential data encrypted and restores it on load", async () => {
    const cred: Credential = {
      type: "kyc",
      title: "KYC Complete",
      claim: "identity verified",
      issuer: "Test Issuer",
      issuerId: "issuer-1",
      holder: "GTESTHOLDER",
      value: "1995-06-15",
      salt: "0xabc123",
      commitment: "0xcommitment123",
      sig: [1, 2, 3],
      issuerPubX: [4, 5, 6],
      issuerPubY: [7, 8, 9],
      issuedAt: 1700000000,
      expiry: "30 days",
    };

    await saveCredential(cred);

    const raw = localStorage.getItem("stellarcred:credentials");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("1995-06-15");
    expect(raw).not.toContain("0xabc123");
    expect(raw).not.toContain('"type":"kyc"');

    const reloaded = await loadCredentials();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      type: "kyc",
      title: "KYC Complete",
      holder: "GTESTHOLDER",
      value: "1995-06-15",
      salt: "0xabc123",
      commitment: "0xcommitment123",
    });
  });
});
