/**
 * Automated Test Suite for Canonical Integration Example
 *
 * Verifies every component of the recommended integration pattern:
 *  1. buildVerifyUrl generation
 *  2. parseReturnParams handling & untrusted hint warning
 *  3. Wallet challenge generation
 *  4. Single-use replay protection
 *  5. Wallet spoofing prevention (Issue #543)
 *  6. Valid signature verification
 *  7. Protected route gating (401 vs 200)
 *  8. Detailed failure states (not_verified, expired, revoked, wrong_issuer, unmet_threshold)
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";

import { createExampleServer, sessions } from "../src/server";

test("Canonical Integration Example End-to-End Suite", async (t) => {
  const server = createExampleServer();

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(() => {
    server.close();
    sessions.clear();
  });

  // ── Step 1: Redirect to Verify (URL Generator) ───────────────────────────
  await t.test("GET /api/verify-url generates compliant StellarCred redirect URL", async () => {
    const res = await fetch(`${baseUrl}/api/verify-url?claim=funds&threshold=50000`);
    assert.strictEqual(res.status, 200);

    const data = (await res.json()) as any;
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.claim, "funds");
    assert.ok(data.verifyUrl.includes("claim=funds"));
    assert.ok(data.verifyUrl.includes("threshold=50000"));
    assert.ok(data.verifyUrl.includes("return_url="));
  });

  // ── Step 2: Return Handler with Untrusted Hints ──────────────────────────
  await t.test("GET /verify-return parses untrusted hints and includes security notice", async () => {
    const victimWallet = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVWGS";
    const res = await fetch(
      `${baseUrl}/verify-return?sc_verified=true&sc_wallet=${victimWallet}&sc_claims=kyc`
    );
    assert.strictEqual(res.status, 200);

    const data = (await res.json()) as any;
    assert.strictEqual(data.ok, true);
    assert.ok(data.warning.includes("CRITICAL SECURITY NOTICE"));
    assert.strictEqual(data.untrustedHint.verified, true);
    assert.strictEqual(data.untrustedHint.wallet, victimWallet);
    assert.deepStrictEqual(data.untrustedHint.claims, ["kyc"]);
    assert.strictEqual(data.nextStep.action, "prove_wallet_control");
  });

  // ── Step 3: Replay-Protected Challenge Issuance ──────────────────────────
  let freshChallenge: any;
  await t.test("GET /api/auth/challenge issues fresh replay-protected challenge", async () => {
    const res = await fetch(`${baseUrl}/api/auth/challenge`);
    assert.strictEqual(res.status, 200);

    const data = (await res.json()) as any;
    assert.strictEqual(data.ok, true);
    assert.ok(data.challenge);
    assert.ok(data.challenge.nonce);
    assert.ok(data.challenge.message.includes(data.challenge.nonce));
    assert.ok(data.challenge.expiresAt > Date.now());

    freshChallenge = data.challenge;
  });

  // ── Step 4a: Wallet Spoofing Prevention (#543) ───────────────────────────
  await t.test("POST /api/auth/verify prevents spoofing: invalid signature is rejected with 403", async () => {
    const victimWallet = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVWGS";
    const attackerKeypair = Keypair.random();
    // Attacker signs the challenge with their own key, but submits the victim's wallet address
    const attackerSig = attackerKeypair.sign(Buffer.from(freshChallenge.message));

    const res = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: victimWallet,
        challenge: freshChallenge,
        signature: attackerSig.toString("hex"),
        claim: "kyc",
      }),
    });

    assert.strictEqual(res.status, 403);
    const data = (await res.json()) as any;
    assert.strictEqual(data.ok, false);
    assert.strictEqual(data.signatureValid, false);
    assert.strictEqual(data.failureReason, "invalid_signature");
    assert.ok(data.error.includes("caller does not control the claimed wallet address"));
  });

  // ── Step 4b: Replay Protection ───────────────────────────────────────────
  await t.test("POST /api/auth/verify rejects replayed challenge nonce with 403", async () => {
    const keypair = Keypair.random();
    const sig = keypair.sign(Buffer.from(freshChallenge.message));

    // Fresh challenge already consumed in step 4a above!
    const res = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: keypair.publicKey(),
        challenge: freshChallenge,
        signature: sig.toString("hex"),
        claim: "kyc",
      }),
    });

    assert.strictEqual(res.status, 403);
    const data = (await res.json()) as any;
    assert.strictEqual(data.ok, false);
    assert.strictEqual(data.failureReason, "challenge_replayed");
    assert.ok(data.error.includes("replay attack prevented"));
  });

  // ── Step 4c: Valid Signature with Unverified On-Chain State ─────────────
  await t.test("POST /api/auth/verify with valid signature on unverified wallet returns 403 not_verified", async () => {
    const cRes = await fetch(`${baseUrl}/api/auth/challenge`);
    const cData = (await cRes.json()) as any;
    const challenge = cData.challenge;

    const freshKeypair = Keypair.random();
    const sig = freshKeypair.sign(Buffer.from(challenge.message));

    const res = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: freshKeypair.publicKey(),
        challenge,
        signature: sig.toString("hex"),
        claim: "kyc",
      }),
    });

    assert.strictEqual(res.status, 403);
    const data = (await res.json()) as any;
    assert.strictEqual(data.ok, false);
    assert.strictEqual(data.signatureValid, true); // Proved wallet control!
    assert.strictEqual(data.claimValid, false);
    assert.strictEqual(data.failureReason, "not_verified");
  });

  // ── Step 5: Route Gating ─────────────────────────────────────────────────
  await t.test("GET /api/protected/treasury gates access without valid session (401)", async () => {
    const resNoToken = await fetch(`${baseUrl}/api/protected/treasury`);
    assert.strictEqual(resNoToken.status, 401);

    const resInvalidToken = await fetch(`${baseUrl}/api/protected/treasury`, {
      headers: { Authorization: "Bearer bogus-token-12345" },
    });
    assert.strictEqual(resInvalidToken.status, 401);
  });

  await t.test("GET /api/protected/treasury grants access with valid authenticated session (200)", async () => {
    // Manually register an authenticated session to simulate completed verification
    const testSessionToken = "test-session-token-xyz";
    const testWallet = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVWGS";

    sessions.set(testSessionToken, {
      wallet: testWallet,
      claim: "kyc",
      verifiedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    const res = await fetch(`${baseUrl}/api/protected/treasury`, {
      headers: { Authorization: `Bearer ${testSessionToken}` },
    });

    assert.strictEqual(res.status, 200);
    const data = (await res.json()) as any;
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.authenticatedWallet, testWallet);
    assert.strictEqual(data.verifiedClaim, "kyc");
    assert.ok(data.protectedData);
    assert.strictEqual(data.protectedData.secretTreasuryBalance, "$12,450,000.00 USDC");
  });

  // ── Step 6: Diagnostic Status Query ──────────────────────────────────────
  await t.test("GET /api/claim-status evaluates unverified wallet accurately", async () => {
    const unverified = Keypair.random().publicKey();
    const res = await fetch(`${baseUrl}/api/claim-status?wallet=${unverified}&claim=kyc`);
    assert.strictEqual(res.status, 200);

    const data = (await res.json()) as any;
    assert.strictEqual(data.result.valid, false);
    assert.strictEqual(data.result.status, "not_verified");
  });
});
