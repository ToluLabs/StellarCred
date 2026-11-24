// Unit coverage for lib/ledger-review.ts (issue #1040). The review must
// describe exactly the bytes a Ledger signs: the SHA-256 of the transaction's
// signature base (what the device shows when it can't render the operations),
// plus the envelope fields that feed that hash.

import { describe, expect, it } from "vitest";
import { Account, Asset, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  BLIND_SIGNED_OPERATION_TYPES,
  buildLedgerReview,
  isBlindSignedOperation,
} from "../ledger-review";

const TEST_NET = "Test SDF Network ; September 2015";

function baseBuilder(passphrase = TEST_NET) {
  return new TransactionBuilder(new Account(Keypair.random().publicKey(), "42"), {
    fee: "100",
    networkPassphrase: passphrase,
  });
}

function paymentTx(passphrase = TEST_NET, memo?: string) {
  const builder = baseBuilder(passphrase);
  if (memo) builder.addMemo(Memo.text(memo));
  return builder
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1.5",
      }),
    )
    .setTimeout(60)
    .build();
}

function sorobanTx() {
  return baseBuilder().addOperation(Operation.restoreFootprint({})).setTimeout(60).build();
}

describe("buildLedgerReview", () => {
  it("reports the hash the device signs, matching the stellar-sdk transaction hash", () => {
    const tx = paymentTx();
    const review = buildLedgerReview(tx.toXDR(), TEST_NET);

    expect(review.envelopeHash).toBe(tx.hash().toString("hex"));
    expect(review.envelopeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(review.networkPassphrase).toBe(TEST_NET);
  });

  it("describes the signed envelope fields", () => {
    const tx = paymentTx(TEST_NET, "backup-2026");
    const review = buildLedgerReview(tx.toXDR(), TEST_NET);

    expect(review.fee).toBe("100");
    expect(review.sequence).toBe("43");
    expect(review.operationCount).toBe(1);
    expect(review.operationTypes).toEqual(["payment"]);
    expect(review.memo).toContain("backup-2026");
    expect(review.timeBounds).not.toBeNull();
    expect(review.blindSigning).toBe(false);
    expect(review.blindSigningReasons).toEqual([]);
  });

  it("reports no memo and no time bounds when the envelope has none", () => {
    const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
      fee: "100",
      networkPassphrase: TEST_NET,
      timebounds: { minTime: 0, maxTime: 0 },
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        }),
      )
      .build();

    const review = buildLedgerReview(tx.toXDR(), TEST_NET);
    expect(review.memo).toBeNull();
  });

  it("flags Soroban operations as hash-signed, the way a proof submission is", () => {
    const tx = sorobanTx();
    const review = buildLedgerReview(tx.toXDR(), TEST_NET);

    expect(review.operationTypes).toEqual(["restoreFootprint"]);
    expect(review.blindSigning).toBe(true);
    expect(review.blindSigningReasons).toHaveLength(1);
    expect(review.blindSigningReasons[0]).toMatch(/restoreFootprint/);
    expect(review.blindSigningReasons[0]).toMatch(/hash/i);
  });

  it("produces a different envelope hash when the network passphrase changes", () => {
    const tx = paymentTx();
    const testnet = buildLedgerReview(tx.toXDR(), TEST_NET);
    const mainnet = buildLedgerReview(tx.toXDR(), "Public Global Stellar Network ; September 2015");

    // The signature base includes the network id, so the same envelope is a
    // different hash on another network — which is why the review shows it.
    expect(mainnet.envelopeHash).not.toBe(testnet.envelopeHash);
    expect(mainnet.networkPassphrase).toContain("Public");
  });

  it("rejects undecodable XDR instead of reviewing the wrong envelope", () => {
    expect(() => buildLedgerReview("not-an-envelope", TEST_NET)).toThrow(
      /unable to decode transaction for ledger review/i,
    );
  });
});

describe("isBlindSignedOperation", () => {
  it("covers the Soroban operation types", () => {
    for (const type of BLIND_SIGNED_OPERATION_TYPES) {
      expect(isBlindSignedOperation(type)).toBe(true);
    }
  });

  it("does not flag operations the device can render", () => {
    expect(isBlindSignedOperation("payment")).toBe(false);
    expect(isBlindSignedOperation("manageData")).toBe(false);
  });
});
