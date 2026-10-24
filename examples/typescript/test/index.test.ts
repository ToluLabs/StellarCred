import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  initializeSdk,
  verifyCredential,
  fetchProofRecord,
  proveAndVerifyWalletControl,
  createAndSignGatedPayment,
} from "../src/index.js";

test("TypeScript SDK Example Suite", async (t) => {
  initializeSdk({
    registryId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    requestTimeoutMs: 5000,
  });

  await t.test("initializeSdk configures SDK without errors", () => {
    assert.doesNotThrow(() => {
      initializeSdk();
    });
  });

  await t.test("proveAndVerifyWalletControl verifies wallet signature with ed25519", async () => {
    const keypair = Keypair.random();
    const result = await proveAndVerifyWalletControl(keypair, "kyc", "test.stellarcred.xyz");

    // The signature itself must be cryptographically valid
    assert.strictEqual(result.signatureValid, true);
    assert.strictEqual(typeof result.claimValid, "boolean");
  });

  await t.test("createAndSignGatedPayment fails closed when credential is not satisfied", async () => {
    const sender = Keypair.random();
    const recipient = Keypair.random();

    await assert.rejects(
      async () => {
        await createAndSignGatedPayment(sender, recipient.publicKey(), "5.0000000", {
          claimType: "kyc",
        });
      },
      {
        name: "Error",
        message: new RegExp(`Credential gate failed: Wallet ${sender.publicKey()} does not satisfy requirement "kyc"`),
      }
    );
  });

  await t.test("verifyCredential returns false for uncredentialed random wallet", async () => {
    const randomAddress = Keypair.random().publicKey();
    const hasClaim = await verifyCredential(randomAddress, "kyc");
    assert.strictEqual(hasClaim, false);
  });

  await t.test("fetchProofRecord returns null for uncredentialed random wallet", async () => {
    const randomAddress = Keypair.random().publicKey();
    const record = await fetchProofRecord(randomAddress, "kyc");
    assert.strictEqual(record, null);
  });
});
