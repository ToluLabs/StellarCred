import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createWalletChallenge,
  verifyWalletSignature,
  verifyWalletClaim,
  MemoryChallengeStore,
} from "./challenge";
import * as claimsModule from "./claims";

describe("challenge generation & replay protection (#543)", () => {
  let store: MemoryChallengeStore;

  beforeEach(() => {
    store = new MemoryChallengeStore();
  });

  it("creates challenge with required fields and defaults", () => {
    const challenge = createWalletChallenge({}, store);
    expect(challenge.nonce).toBeTruthy();
    expect(typeof challenge.nonce).toBe("string");
    expect(challenge.issuedAt).toBeLessThanOrEqual(Date.now());
    expect(challenge.expiresAt).toBeGreaterThan(challenge.issuedAt);
    expect(challenge.domain).toBe("stellarcred");
    expect(challenge.message).toContain("stellarcred requests you sign this message");
    expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
  });

  it("respects custom domain, statement, and ttlMs", () => {
    const challenge = createWalletChallenge(
      {
        domain: "lendfi.xyz",
        statement: "Verify wallet for loan disbursement",
        ttlMs: 60_000,
      },
      store,
    );
    expect(challenge.domain).toBe("lendfi.xyz");
    expect(challenge.statement).toBe("Verify wallet for loan disbursement");
    expect(challenge.expiresAt - challenge.issuedAt).toBe(60_000);
    expect(challenge.message).toContain("lendfi.xyz");
    expect(challenge.message).toContain("Verify wallet for loan disbursement");
  });

  it("generates distinct nonces for distinct challenges", () => {
    const c1 = createWalletChallenge({}, store);
    const c2 = createWalletChallenge({}, store);
    expect(c1.nonce).not.toBe(c2.nonce);
  });

  it("enforces single-use replay protection via store", () => {
    const challenge = createWalletChallenge({}, store);
    // First consume succeeds
    expect(store.consume(challenge.nonce)).toBe(true);
    // Second consume immediately fails (replay prevented)
    expect(store.consume(challenge.nonce)).toBe(false);
  });

  it("rejects expired nonces", () => {
    const expiredStore = new MemoryChallengeStore();
    expiredStore.save("expired-nonce", Date.now() - 1000);
    expect(expiredStore.consume("expired-nonce")).toBe(false);
  });
});

describe("verifyWalletSignature (#543)", () => {
  const keypair = Keypair.random();
  const wallet = keypair.publicKey();
  const message = "Sign this message to prove ownership of G...";

  it("verifies valid raw signature Uint8Array", () => {
    const sig = keypair.sign(Buffer.from(message));
    expect(verifyWalletSignature(wallet, message, sig)).toBe(true);
  });

  it("verifies valid hex signature string", () => {
    const sigHex = keypair.sign(Buffer.from(message)).toString("hex");
    expect(verifyWalletSignature(wallet, message, sigHex)).toBe(true);
  });

  it("verifies valid base64 signature string", () => {
    const sigB64 = keypair.sign(Buffer.from(message)).toString("base64");
    expect(verifyWalletSignature(wallet, message, sigB64)).toBe(true);
  });

  it("rejects signature when message was tampered", () => {
    const sig = keypair.sign(Buffer.from(message));
    expect(verifyWalletSignature(wallet, message + " (tampered)", sig)).toBe(false);
  });

  it("rejects signature verified against wrong wallet (spoof attempt)", () => {
    const anotherKeypair = Keypair.random();
    const sig = keypair.sign(Buffer.from(message));
    expect(verifyWalletSignature(anotherKeypair.publicKey(), message, sig)).toBe(false);
  });

  it("fails safely on invalid or malformed wallet or signature", () => {
    expect(verifyWalletSignature("not-a-wallet", message, "invalid-sig")).toBe(false);
    expect(verifyWalletSignature(wallet, message, "")).toBe(false);
  });
});

describe("verifyWalletClaim helper (#543)", () => {
  const keypair = Keypair.random();
  const wallet = keypair.publicKey();
  let store: MemoryChallengeStore;

  beforeEach(() => {
    store = new MemoryChallengeStore();
    vi.restoreAllMocks();
  });

  it("rejects invalid wallet address", async () => {
    const challenge = createWalletChallenge({}, store);
    const result = await verifyWalletClaim({
      wallet: "G_INVALID",
      challenge,
      signature: "abc",
      claim: "kyc",
      store,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid Stellar wallet public address");
  });

  it("rejects replayed challenges", async () => {
    const challenge = createWalletChallenge({}, store);
    const sig = keypair.sign(Buffer.from(challenge.message));

    // First run with mock hasClaim
    vi.spyOn(claimsModule, "hasClaim").mockResolvedValue(true);
    vi.spyOn(claimsModule, "getClaims").mockResolvedValue([
      {
        type: "kyc",
        verifiedAt: 1000,
        expiry: 2000,
      },
    ]);


    const res1 = await verifyWalletClaim({
      wallet,
      challenge,
      signature: sig,
      claim: "kyc",
      store,
    });
    expect(res1.ok).toBe(true);
    expect(res1.signatureValid).toBe(true);
    expect(res1.claimValid).toBe(true);

    // Second run with the same challenge nonce (replay attack)
    const res2 = await verifyWalletClaim({
      wallet,
      challenge,
      signature: sig,
      claim: "kyc",
      store,
    });
    expect(res2.ok).toBe(false);
    expect(res2.signatureValid).toBe(false);
    expect(res2.error).toContain("replay attack prevented");
  });

  it("prevents wallet spoofing: invalid signature fails before checking claims", async () => {
    const challenge = createWalletChallenge({}, store);
    // Attacker submits victim's wallet but attacker's signature
    const attackerKeypair = Keypair.random();
    const attackerSig = attackerKeypair.sign(Buffer.from(challenge.message));

    const hasClaimSpy = vi.spyOn(claimsModule, "hasClaim");

    const result = await verifyWalletClaim({
      wallet, // victim address
      challenge,
      signature: attackerSig, // invalid for victim
      claim: "kyc",
      store,
    });

    expect(result.ok).toBe(false);
    expect(result.signatureValid).toBe(false);
    expect(result.claimValid).toBe(false);
    expect(result.error).toContain("caller does not control the claimed wallet address");
    // Proof that on-chain check was not even trusted / called with spoofed identity
    expect(hasClaimSpy).not.toHaveBeenCalled();
  });

  it("returns ok: false when wallet signature is valid but on-chain claim is missing", async () => {
    const challenge = createWalletChallenge({}, store);
    const sig = keypair.sign(Buffer.from(challenge.message));

    vi.spyOn(claimsModule, "hasClaim").mockResolvedValue(false);

    const result = await verifyWalletClaim({
      wallet,
      challenge,
      signature: sig,
      claim: "age",
      store,
    });

    expect(result.ok).toBe(false);
    expect(result.signatureValid).toBe(true);
    expect(result.claimValid).toBe(false);
    expect(result.error).toContain("does not possess an active on-chain 'age' credential");
  });

  it("returns ok: true with claimDetails when signature and on-chain claim are valid", async () => {
    const challenge = createWalletChallenge({ domain: "app.fundvault.xyz" }, store);
    const sig = keypair.sign(Buffer.from(challenge.message));

    const mockClaim = {
      type: "funds",
      verifiedAt: 1780000000,
      expiry: 1800000000,
    };
    vi.spyOn(claimsModule, "hasClaim").mockResolvedValue(true);
    vi.spyOn(claimsModule, "getClaims").mockResolvedValue([mockClaim]);


    const result = await verifyWalletClaim({
      wallet,
      challenge,
      signature: sig,
      claim: "funds",
      claimOptions: { minThreshold: 50_000 },
      store,
    });

    expect(result.ok).toBe(true);
    expect(result.wallet).toBe(wallet);
    expect(result.signatureValid).toBe(true);
    expect(result.claimValid).toBe(true);
    expect(result.claimDetails).toEqual(mockClaim);
  });
});
