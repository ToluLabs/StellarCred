// Tests for @stellarcred/sdk/testing (#1065): the mock wallet, the credential
// factory and the in-memory ProofRegistry, exercised through the public SDK
// calls an integrator would make in their own unit tests.

import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

import {
  checkClaimStatus,
  configure,
  createWalletChallenge,
  getClaims,
  getClaimRecord,
  hasClaim,
  hasClaims,
  isNullifierUsed,
  MemoryChallengeStore,
  resetConfig,
  RpcError,
  validateCredential,
  verifyUniquePersonhood,
  verifyWalletClaim,
  verifyWalletSignature,
} from "./index";
import {
  CredentialFactory,
  MockProofRegistry,
  MockWalletProvider,
  MockWalletRejectedError,
  getInstalledMockRegistry,
  installMockRegistry,
  uninstallMockRegistry,
  verifyCredentialSignature,
} from "./testing";

const DAY = 86_400;
const NO_RETRY = { retries: 0 };

beforeEach(() => {
  resetConfig();
});

afterEach(() => {
  uninstallMockRegistry();
  resetConfig();
});

// ---------------------------------------------------------------------------
// CredentialFactory
// ---------------------------------------------------------------------------

describe("CredentialFactory", () => {
  it("creates credentials that pass validateCredential for every credential type", () => {
    const factory = new CredentialFactory();
    const types = [
      "kyc",
      "age",
      "income",
      "jurisdiction",
      "funds",
      "accreditation",
      "employment",
    ] as const;
    for (const type of types) {
      const result = validateCredential(factory.create({ type }));
      expect(result, type).toEqual({ valid: true, credential: expect.any(Object) });
    }
  });

  it("signs the commitment with a secp256k1 key that verifies", () => {
    const credential = new CredentialFactory().create({ type: "kyc" });
    expect(credential.sig).toHaveLength(64);
    expect(verifyCredentialSignature(credential)).toBe(true);
  });

  it("produces signatures an independent implementation (node:crypto) accepts", () => {
    const factory = new CredentialFactory();
    const message = Buffer.from("stellarcred cross-check");
    // Sign sha256(message) as the raw commitment so node:crypto, which always
    // hashes, can check the same digest.
    const digest = createHash("sha256").update(message).digest("hex");
    const credential = factory.create({ commitment: "0x" + digest });
    const b64url = (bytes: number[]) => Buffer.from(bytes).toString("base64url");
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "secp256k1",
        x: b64url(credential.issuerPubX),
        y: b64url(credential.issuerPubY),
      },
      format: "jwk",
    });
    const ok = nodeVerify(
      "sha256",
      message,
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(credential.sig),
    );
    expect(ok).toBe(true);
  });

  it("emits low-s signatures, as @noble/curves and the Noir circuit expect", () => {
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const factory = new CredentialFactory();
    for (let i = 0; i < 10; i++) {
      const { sig } = factory.create();
      const s = BigInt("0x" + Buffer.from(sig.slice(32)).toString("hex"));
      expect(s <= n / 2n).toBe(true);
    }
  });

  it("derives the issuer public key from a fixed private key (generator for key = 1)", () => {
    const factory = new CredentialFactory({ issuerPrivateKey: "0".repeat(63) + "1" });
    expect(Buffer.from(factory.issuerPublicKey.x).toString("hex")).toBe(
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
    expect(Buffer.from(factory.issuerPublicKey.y).toString("hex")).toBe(
      "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
    );
  });

  it("rejects malformed issuer keys", () => {
    expect(() => new CredentialFactory({ issuerPrivateKey: "abc" })).toThrow(/64 hex/);
    expect(() => new CredentialFactory({ issuerPrivateKey: "0".repeat(64) })).toThrow(/range/);
  });

  it("detects a tampered commitment, signature or issuer key", () => {
    const factory = new CredentialFactory();
    const credential = factory.create();
    expect(verifyCredentialSignature({ ...credential, commitment: "0x1234" })).toBe(false);
    const sig = [...credential.sig];
    sig[10] ^= 1;
    expect(verifyCredentialSignature({ ...credential, sig })).toBe(false);
    const other = new CredentialFactory().create();
    expect(
      verifyCredentialSignature({
        ...credential,
        issuerPubX: other.issuerPubX,
        issuerPubY: other.issuerPubY,
      }),
    ).toBe(false);
    expect(verifyCredentialSignature({ ...credential, sig: [1, 2, 3] })).toBe(false);
  });

  it("uses the factory issuer, clock and overrides", () => {
    const factory = new CredentialFactory({
      issuerId: "GISSUER",
      issuerName: "Acme KYC",
      now: () => 1_700_000_000_000,
    });
    const holder = Keypair.random().publicKey();
    const credential = factory.create({
      type: "age",
      holder,
      claimParams: { threshold_years: "21" },
      expiry: "30 days",
    });
    expect(credential).toMatchObject({
      type: "age",
      holder,
      issuer: "Acme KYC",
      issuerId: "GISSUER",
      issuedAt: 1_700_000_000,
      expiry: "30 days",
      claim: "age ≥ 21",
      claimParams: { threshold_years: "21" },
    });
  });

  it("gives each credential its own salt and commitment", () => {
    const factory = new CredentialFactory();
    const a = factory.create();
    const b = factory.create();
    expect(a.salt).not.toBe(b.salt);
    expect(a.commitment).not.toBe(b.commitment);
  });

  it("createMany issues one credential per type for a single holder", () => {
    const creds = new CredentialFactory().createMany(["kyc", "age", "funds"]);
    expect(creds.map((c) => c.type)).toEqual(["kyc", "age", "funds"]);
    expect(new Set(creds.map((c) => c.holder)).size).toBe(1);
  });

  it("rejects unknown credential types", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new CredentialFactory().create({ type: "passport" as any })).toThrow(/Unknown/);
  });
});

// ---------------------------------------------------------------------------
// MockWalletProvider
// ---------------------------------------------------------------------------

describe("MockWalletProvider", () => {
  it("exposes a valid Stellar address through the SEP-43 getAddress call", async () => {
    const wallet = MockWalletProvider.random();
    expect(wallet.address).toMatch(/^G[A-Z2-7]{55}$/);
    await expect(wallet.getAddress()).resolves.toEqual({ address: wallet.address });
  });

  it("is deterministic when given a secret", () => {
    const kp = Keypair.random();
    expect(new MockWalletProvider({ secret: kp.secret() }).address).toBe(kp.publicKey());
  });

  it("signs messages that verifyWalletSignature accepts", async () => {
    const wallet = MockWalletProvider.random();
    const { signedMessage, signerAddress } = await wallet.signMessage("hello");
    expect(signerAddress).toBe(wallet.address);
    expect(verifyWalletSignature(wallet.address, "hello", signedMessage)).toBe(true);
    expect(verifyWalletSignature(wallet.address, "hellO", signedMessage)).toBe(false);
    expect(verifyWalletSignature(Keypair.random().publicKey(), "hello", signedMessage)).toBe(false);
  });

  it("refuses to sign for another address", async () => {
    const wallet = MockWalletProvider.random();
    await expect(
      wallet.signMessage("hi", { address: Keypair.random().publicKey() }),
    ).rejects.toThrow(/cannot sign/);
  });

  it("signs transactions with the wallet key", async () => {
    const wallet = MockWalletProvider.random();
    const tx = new TransactionBuilder(new Account(wallet.address, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
      .setTimeout(30)
      .build();

    const { signedTxXdr, signerAddress } = await wallet.signTransaction(tx.toXDR(), {
      networkPassphrase: Networks.TESTNET,
    });
    expect(signerAddress).toBe(wallet.address);
    const signed = TransactionBuilder.fromXDR(signedTxXdr, Networks.TESTNET);
    expect(signed.signatures).toHaveLength(1);
    expect(wallet.keypair.verify(signed.hash(), signed.signatures[0].signature())).toBe(true);
  });

  it("simulates a user rejecting the prompt, and records every call", async () => {
    const wallet = new MockWalletProvider({ reject: "nope" });
    const err = await wallet.signMessage("x").catch((e) => e);
    expect(err).toBeInstanceOf(MockWalletRejectedError);
    expect(err.code).toBe(-4);
    expect(err.message).toBe("nope");

    wallet.rejectRequests(false);
    await wallet.getAddress();
    expect(wallet.calls.map((c) => c.method)).toEqual(["signMessage", "getAddress"]);
  });
});

// ---------------------------------------------------------------------------
// MockProofRegistry through the SDK's public reads
// ---------------------------------------------------------------------------

describe("MockProofRegistry + installMockRegistry", () => {
  it("answers hasClaim without a registryId or RPC", async () => {
    const registry = installMockRegistry();
    const credential = new CredentialFactory().create({ type: "kyc" });
    expect(await hasClaim(credential.holder, "kyc")).toBe(false);
    registry.prove(credential);
    expect(await hasClaim(credential.holder, "kyc")).toBe(true);
    expect(await hasClaim(credential.holder, "age")).toBe(false);
    expect(registry.calls.every((c) => c.method === "is_verified")).toBe(true);
  });

  it("returns and clears the installed registry", () => {
    const registry = installMockRegistry();
    expect(getInstalledMockRegistry()).toBe(registry);
    uninstallMockRegistry();
    expect(getInstalledMockRegistry()).toBeNull();
  });

  it("stops serving reads once uninstalled", async () => {
    const registry = installMockRegistry();
    const credential = new CredentialFactory().create();
    registry.prove(credential);
    uninstallMockRegistry();
    // No registryId configured, so the real path fails soft to false (and warns).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await hasClaim(credential.holder, "kyc")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reaches reads made through a separate copy of the SDK module (CJS entry points)", async () => {
    const registry = installMockRegistry();
    const credential = new CredentialFactory().create();
    registry.prove(credential);
    vi.resetModules();
    const separateCopy = await import("./claims");
    expect(await separateCopy.hasClaim(credential.holder, "kyc")).toBe(true);
  });

  it("drops cached claim reads when a registry is installed or swapped", async () => {
    configure({ claimCache: true });
    const first = installMockRegistry();
    const credential = new CredentialFactory().create();
    first.prove(credential);
    expect(await hasClaim(credential.holder, "kyc")).toBe(true);

    installMockRegistry(new MockProofRegistry());
    expect(await hasClaim(credential.holder, "kyc")).toBe(false);
  });

  it("takes the proof expiry from the credential and honours the ledger clock", async () => {
    const registry = installMockRegistry().setLedgerTime(1_800_000_000);
    const credential = new CredentialFactory().create({ expiry: "10 days" });
    const record = registry.prove(credential);
    expect(record.expiry).toBe(BigInt(1_800_000_000 + 10 * DAY));

    registry.advanceTime(10 * DAY - 1);
    expect(await hasClaim(credential.holder, "kyc")).toBe(true);
    registry.advanceTime(1);
    expect(await hasClaim(credential.holder, "kyc")).toBe(false);
  });

  it("treats a proof as expired once ledger time reaches expiry (contract semantics)", async () => {
    const registry = installMockRegistry();
    const holder = Keypair.random().publicKey();
    const now = registry.now();
    registry.setLedgerTime(now).addProof({ holder, type: "kyc", expiresInSeconds: 100 });

    expect(await hasClaim(holder, "kyc")).toBe(true);
    registry.advanceTime(99);
    expect(await hasClaim(holder, "kyc")).toBe(true);
    registry.advanceTime(1);
    expect(await hasClaim(holder, "kyc")).toBe(false);
  });

  it("reports revocation through checkClaimStatus", async () => {
    const registry = installMockRegistry();
    const credential = new CredentialFactory().create();
    registry.prove(credential);
    registry.revoke(credential.holder, "kyc", "fraud");

    expect(await hasClaim(credential.holder, "kyc")).toBe(false);
    const status = await checkClaimStatus(credential.holder, "kyc");
    expect(status.status).toBe("revoked");
    expect(status.record?.reason).toBe("fraud");
    expect(status.record?.issuer).toBe(credential.issuerId);
  });

  it("reports not_verified and expired statuses", async () => {
    const registry = installMockRegistry();
    const holder = Keypair.random().publicKey();
    expect((await checkClaimStatus(holder, "kyc")).status).toBe("not_verified");

    const now = Math.floor(Date.now() / 1000);
    registry.addProof({ holder, type: "kyc", expiry: now - 10, verifiedAt: now - 100 });
    expect((await checkClaimStatus(holder, "kyc")).status).toBe("expired");
  });

  it("enforces trusted issuers", async () => {
    const registry = installMockRegistry();
    const trusted = new CredentialFactory({ issuerId: Keypair.random().publicKey() });
    const untrusted = new CredentialFactory({ issuerId: Keypair.random().publicKey() });
    const holder = Keypair.random().publicKey();
    registry.prove(untrusted.create({ holder }));

    const opts = { trustedIssuers: [trusted.issuerId] };
    expect(await hasClaim(holder, "kyc", opts)).toBe(false);
    expect((await checkClaimStatus(holder, "kyc", opts)).status).toBe("wrong_issuer");

    registry.prove(trusted.create({ holder }));
    expect(await hasClaim(holder, "kyc", opts)).toBe(true);
  });

  it("rejects a proof with no issuer under a trusted-issuer filter", async () => {
    const registry = installMockRegistry();
    const holder = Keypair.random().publicKey();
    registry.addProof({ holder, type: "kyc" });
    expect(await hasClaim(holder, "kyc")).toBe(true);
    expect(await hasClaim(holder, "kyc", { trustedIssuers: [Keypair.random().publicKey()] })).toBe(
      false,
    );
  });

  it("compares thresholds for parameterised claims (check_claim)", async () => {
    const registry = installMockRegistry();
    const credential = new CredentialFactory().create({
      type: "age",
      claimParams: { threshold_years: "21" },
    });
    registry.prove(credential);

    expect(await hasClaim(credential.holder, "age", { minThreshold: 18 })).toBe(true);
    expect(await hasClaim(credential.holder, "age", { minThreshold: 21 })).toBe(true);
    expect(await hasClaim(credential.holder, "age", { minThreshold: 25 })).toBe(false);
    expect((await checkClaimStatus(credential.holder, "age", { minThreshold: 25 })).status).toBe(
      "unmet_threshold",
    );
    expect(registry.calls.some((c) => c.method === "check_claim")).toBe(true);
  });

  it("serves getClaims, hasClaims and getClaimRecord", async () => {
    const registry = installMockRegistry();
    const creds = new CredentialFactory().createMany(["kyc", "funds"]);
    creds.forEach((c) => registry.prove(c));
    const holder = creds[0].holder;

    const claims = await getClaims(holder);
    expect(claims.map((c) => c.type).sort()).toEqual(["funds", "kyc"]);
    expect(await hasClaims(holder, ["kyc", "funds", "age"])).toEqual({
      kyc: true,
      funds: true,
      age: false,
    });
    const record = await getClaimRecord(holder, "kyc");
    expect(record).toMatchObject({ revoked: false, vkVersion: 1 });
  });

  it("simulates RPC failures for fail-soft and throwOnError paths", async () => {
    const registry = installMockRegistry();
    const credential = new CredentialFactory().create();
    registry.prove(credential);

    registry.failNextReads();
    expect(await hasClaim(credential.holder, "kyc", { retryOptions: NO_RETRY })).toBe(false);
    expect(await hasClaim(credential.holder, "kyc")).toBe(true);

    registry.failNextReads();
    await expect(
      hasClaim(credential.holder, "kyc", { throwOnError: true, retryOptions: NO_RETRY }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it("tracks nullifiers for unique-personhood checks", async () => {
    const registry = installMockRegistry();
    const credential = new CredentialFactory().create();
    registry.prove(credential);

    expect(await isNullifierUsed("airdrop-1", "0xabc")).toBe(false);
    await expect(
      verifyUniquePersonhood({
        wallet: credential.holder,
        claim: "kyc",
        appContext: "airdrop-1",
        nullifier: "0xabc",
      }),
    ).resolves.toEqual({ verified: true, unique: true });

    registry.useNullifier("airdrop-1", "0xabc");
    expect(await isNullifierUsed("airdrop-1", "0xabc")).toBe(true);
    expect(await isNullifierUsed("airdrop-2", "0xabc")).toBe(false);
  });

  it("refuses to prove a credential whose signature does not verify", () => {
    const registry = new MockProofRegistry();
    const credential = new CredentialFactory().create();
    expect(() => registry.prove({ ...credential, commitment: "0x01" })).toThrow(/signature/);
  });

  it("throws when revoking a proof that does not exist", () => {
    expect(() => new MockProofRegistry().revoke(Keypair.random().publicKey(), "kyc")).toThrow(
      /no proof/,
    );
  });

  it("reset clears proofs, nullifiers, the clock and recorded calls", async () => {
    const registry = installMockRegistry();
    const credential = new CredentialFactory().create();
    registry.prove(credential);
    registry.useNullifier("a", "b").setLedgerTime(1);
    await hasClaim(credential.holder, "kyc");

    registry.reset();
    expect(registry.calls).toHaveLength(0);
    expect(registry.now()).toBeGreaterThan(1);
    expect(await hasClaim(credential.holder, "kyc")).toBe(false);
    expect(await isNullifierUsed("a", "b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End to end: what an integrator's CI test looks like
// ---------------------------------------------------------------------------

describe("integrator flow: wallet challenge + on-chain claim", () => {
  it("passes verifyWalletClaim for a wallet holding a simulated KYC proof", async () => {
    const registry = installMockRegistry();
    const wallet = MockWalletProvider.random();
    registry.prove(new CredentialFactory().create({ type: "kyc", holder: wallet.address }));

    const store = new MemoryChallengeStore();
    const challenge = createWalletChallenge({ domain: "app.test" }, store);
    const signature = await wallet.signChallenge(challenge);

    const result = await verifyWalletClaim({
      wallet: wallet.address,
      challenge,
      signature,
      claim: "kyc",
      store,
    });
    expect(result.ok).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.claimValid).toBe(true);
  });

  it("fails verifyWalletClaim when the claim is revoked, and when another wallet signs", async () => {
    const registry = installMockRegistry();
    const wallet = MockWalletProvider.random();
    const impostor = MockWalletProvider.random();
    registry.prove(new CredentialFactory().create({ holder: wallet.address }));
    const store = new MemoryChallengeStore();

    const c1 = createWalletChallenge({}, store);
    const spoofed = await verifyWalletClaim({
      wallet: wallet.address,
      challenge: c1,
      signature: await impostor.signChallenge(c1),
      claim: "kyc",
      store,
    });
    expect(spoofed.failureReason).toBe("invalid_signature");

    registry.revoke(wallet.address, "kyc");
    const c2 = createWalletChallenge({}, store);
    const revoked = await verifyWalletClaim({
      wallet: wallet.address,
      challenge: c2,
      signature: await wallet.signChallenge(c2),
      claim: "kyc",
      store,
    });
    expect(revoked.ok).toBe(false);
    expect(revoked.signatureValid).toBe(true);
    expect(revoked.failureReason).toBe("revoked");
  });
});
