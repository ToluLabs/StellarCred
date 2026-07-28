import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { IssuerClient, CREDENTIAL_TYPES } from "./index";

// Fixed test key — not a real issuer key, used only to make assertions deterministic.
const TEST_PRIVATE_KEY_64 = "01".repeat(32);

function be32(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
}

describe("IssuerClient constructor", () => {
  it("throws on a missing private key", () => {
    // @ts-expect-error — exercising the runtime guard for a missing key
    expect(() => new IssuerClient({})).toThrow(/64-character hex/);
  });

  it("throws on a malformed private key", () => {
    expect(() => new IssuerClient({ privateKey: "not-hex" })).toThrow(/64-character hex/);
  });

  it("accepts a valid 64-char hex private key", () => {
    expect(() => new IssuerClient({ privateKey: TEST_PRIVATE_KEY_64 })).not.toThrow();
  });
});

describe("IssuerClient.issue — pipeline round-trip", () => {
  it("produces a signature that verifies against the returned commitment and public key with prehash: false", async () => {
    const issuer = new IssuerClient({ privateKey: TEST_PRIVATE_KEY_64 });
    const credential = await issuer.issue({
      type: "kyc",
      holder: "GABCDEXAMPLEHOLDERADDRESS",
      issuerId: "test-issuer",
      issuerName: "Test Issuer",
      expiry: "90 days",
      attribute: {},
    });

    const pubkeyUncompressed = new Uint8Array([
      0x04,
      ...credential.issuerPubX,
      ...credential.issuerPubY,
    ]);
    const digest = be32(BigInt(credential.commitment));
    const sig = Uint8Array.from(credential.sig);

    const ok = secp256k1.verify(sig, digest, pubkeyUncompressed, { prehash: false });
    expect(ok).toBe(true);

    // Independently confirm the returned public key matches the private key.
    const expectedPub = secp256k1.getPublicKey(
      Uint8Array.from(Buffer.from(TEST_PRIVATE_KEY_64, "hex")),
      false,
    );
    expect(pubkeyUncompressed).toEqual(expectedPub);
  });

  it("returns the full Credential shape for an attribute-bearing type", async () => {
    const issuer = new IssuerClient({ privateKey: TEST_PRIVATE_KEY_64 });
    const credential = await issuer.issue({
      type: "age",
      holder: "GABCDEXAMPLEHOLDERADDRESS",
      issuerId: "test-issuer",
      issuerName: "Test Issuer",
      expiry: "30 days",
      attribute: { date_of_birth: "1995-06-15" },
      claimParams: { threshold_years: "18" },
    });

    expect(credential.type).toBe("age");
    expect(credential.title).toBe("Age Verified");
    expect(credential.claim).toBe("age ≥ 18");
    expect(credential.issuer).toBe("Test Issuer");
    expect(credential.issuerId).toBe("test-issuer");
    expect(credential.holder).toBe("GABCDEXAMPLEHOLDERADDRESS");
    expect(typeof credential.value).toBe("string");
    expect(credential.salt).toMatch(/^0x[0-9a-f]{62}$/);
    expect(typeof credential.commitment).toBe("string");
    expect(Array.isArray(credential.sig)).toBe(true);
    expect(credential.issuerPubX).toHaveLength(32);
    expect(credential.issuerPubY).toHaveLength(32);
    expect(typeof credential.issuedAt).toBe("number");
    expect(credential.expiry).toBe("30 days");
    expect(credential.claimParams).toEqual({ threshold_years: "18" });
  });

  it("normalizes a unix-timestamp expiry into a day-count string", async () => {
    const issuer = new IssuerClient({ privateKey: TEST_PRIVATE_KEY_64 });
    const now = Math.floor(Date.now() / 1000);
    const credential = await issuer.issue({
      type: "kyc",
      holder: "GABCDEXAMPLEHOLDERADDRESS",
      issuerId: "test-issuer",
      issuerName: "Test Issuer",
      expiry: now + 31_536_000, // +365 days
      attribute: {},
    });
    expect(credential.expiry).toBe("365 days");
  });

  it("rejects an unknown credential type", async () => {
    const issuer = new IssuerClient({ privateKey: TEST_PRIVATE_KEY_64 });
    await expect(
      issuer.issue({
        // @ts-expect-error — exercising runtime validation of an invalid type
        type: "not-a-real-type",
        holder: "G...",
        issuerId: "test-issuer",
        issuerName: "Test Issuer",
        expiry: "90 days",
        attribute: {},
      }),
    ).rejects.toThrow(/Unknown credential type/);
  });
});

describe("IssuerClient.publicKey", () => {
  it("matches the public key embedded in an issued credential", async () => {
    const issuer = new IssuerClient({ privateKey: TEST_PRIVATE_KEY_64 });
    const { x, y } = issuer.publicKey();
    const credential = await issuer.issue({
      type: "kyc",
      holder: "G...",
      issuerId: "test-issuer",
      issuerName: "Test Issuer",
      expiry: "90 days",
      attribute: {},
    });
    expect(x).toEqual(credential.issuerPubX);
    expect(y).toEqual(credential.issuerPubY);
  });
});

describe("no logging or persistence", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("never calls console.* while issuing a credential with identity-bearing attributes", async () => {
    const issuer = new IssuerClient({ privateKey: TEST_PRIVATE_KEY_64 });
    await issuer.issue({
      type: "age",
      holder: "GABCDEXAMPLEHOLDERADDRESS",
      issuerId: "test-issuer",
      issuerName: "Test Issuer",
      expiry: "90 days",
      attribute: { date_of_birth: "1995-06-15" },
    });
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("CREDENTIAL_TYPES", () => {
  it("matches the six supported credential types", () => {
    expect(CREDENTIAL_TYPES).toEqual([
      "kyc",
      "age",
      "jurisdiction",
      "income",
      "funds",
      "accreditation",
    ]);
  });
});
