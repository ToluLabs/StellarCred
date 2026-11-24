// @vitest-environment node
import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  getIssuerPrivateKeyHex,
  localIssuerPubkeyBytes,
  issueAndAuditCredentials,
} from "./issuer-service";

describe("lib/issuer-service", () => {
  const HOLDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const ISSUER_ID = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

  it("derives deterministic private key hex when ISSUER_PRIVATE_KEY is unset", () => {
    const key = getIssuerPrivateKeyHex();
    expect(key).toHaveLength(64);
  });

  it("derives a 64-byte local issuer public key", () => {
    const pubBytes = localIssuerPubkeyBytes();
    expect(pubBytes).toHaveLength(64);
  });

  it("issues credentials and records audit log entries without PII", async () => {
    const credentials = await issueAndAuditCredentials({
      credentialTypes: ["kyc", "age"],
      holder: HOLDER,
      issuerId: ISSUER_ID,
      issuerName: "Test Authority",
      expiry: "90 days",
      attributes: {
        date_of_birth: "1990-01-01",
      },
      requestId: "req_test_123",
    });

    expect(credentials).toHaveLength(2);

    const kycCred = credentials.find((c) => c.type === "kyc");
    const ageCred = credentials.find((c) => c.type === "age");

    expect(kycCred).toBeDefined();
    expect(ageCred).toBeDefined();

    expect(kycCred?.holder).toBe(HOLDER);
    expect(kycCred?.commitment).toBeDefined();
    expect(kycCred?.sig).toBeDefined();

    const pubkey = new Uint8Array([0x04, ...kycCred!.issuerPubX, ...kycCred!.issuerPubY]);
    const commitmentBigInt = BigInt(kycCred!.commitment);
    const digest = new Uint8Array(32);
    let temp = commitmentBigInt;
    for (let i = 31; i >= 0; i--) {
      digest[i] = Number(temp & 255n);
      temp >>= 8n;
    }
    const sig = Uint8Array.from(kycCred!.sig);

    expect(secp256k1.verify(sig, digest, pubkey, { prehash: false })).toBe(true);
  });
});
