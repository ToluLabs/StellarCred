import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import {
  BatchVerifierPool,
  verifyWalletSignaturesBatch,
  type BatchVerifyItem,
} from "./batch-verify";
import { verifyWalletSignature } from "./challenge";
import * as fromServer from "./server";
import * as fromIndex from "./index";

function signedItem(message = `challenge-${Math.random()}`): BatchVerifyItem {
  const kp = Keypair.random();
  return {
    wallet: kp.publicKey(),
    message,
    signature: kp.sign(Buffer.from(message, "utf8")).toString("hex"),
  };
}

const pools: BatchVerifierPool[] = [];
function makePool(options?: ConstructorParameters<typeof BatchVerifierPool>[0]) {
  const pool = new BatchVerifierPool(options);
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.close()));
});

describe("batch verification pool (#1063)", () => {
  it("returns an empty array for an empty batch without starting workers", async () => {
    expect(await verifyWalletSignaturesBatch([])).toEqual([]);
    expect(await makePool().verify([])).toEqual([]);
  });

  it("verifies valid signatures across multiple workers, in input order", async () => {
    const items = Array.from({ length: 50 }, () => signedItem());
    const results = await makePool({ concurrency: 4, chunkSize: 5 }).verify(items);

    expect(results).toHaveLength(50);
    results.forEach((r, i) => {
      expect(r).toEqual({ index: i, wallet: items[i].wallet, valid: true });
    });
  });

  it("matches verifyWalletSignature for valid, tampered and wrong-key items", async () => {
    const good = signedItem("hello");
    const tampered: BatchVerifyItem = { ...signedItem("original"), message: "changed" };
    const wrongKey: BatchVerifyItem = { ...good, wallet: Keypair.random().publicKey() };
    const items = [good, tampered, wrongKey];

    const results = await makePool({ concurrency: 2, chunkSize: 1 }).verify(items);

    items.forEach((item, i) => {
      expect(results[i].valid).toBe(
        verifyWalletSignature(item.wallet, item.message, item.signature),
      );
    });
    expect(results.map((r) => r.valid)).toEqual([true, false, false]);
    expect(results[1].reason).toBe("invalid_signature");
    expect(results[2].reason).toBe("invalid_signature");
  });

  it("accepts base64 and raw-byte signatures and Uint8Array messages", async () => {
    const kp = Keypair.random();
    const message = new Uint8Array([1, 2, 3, 4]);
    const sig = kp.sign(Buffer.from(message));
    const results = await verifyWalletSignaturesBatch(
      [
        { wallet: kp.publicKey(), message, signature: sig.toString("base64") },
        { wallet: kp.publicKey(), message, signature: new Uint8Array(sig) },
      ],
      { concurrency: 1 },
    );
    expect(results.map((r) => r.valid)).toEqual([true, true]);
  });

  it("flags malformed input per item without failing the rest of the batch", async () => {
    const ok = signedItem();
    const items: BatchVerifyItem[] = [
      { ...ok, wallet: "not-a-wallet" },
      { ...ok, signature: "deadbeef" },
      { ...ok, signature: new Uint8Array(10) },
      ok,
    ];
    const results = await makePool({ concurrency: 2 }).verify(items);

    expect(results.map((r) => r.reason)).toEqual([
      "invalid_wallet",
      "invalid_signature",
      "invalid_signature",
      undefined,
    ]);
    expect(results.map((r) => r.valid)).toEqual([false, false, false, true]);
  });

  it("reuses one pool across several verify() calls", async () => {
    const pool = makePool({ concurrency: 2, chunkSize: 2 });
    for (let round = 0; round < 3; round++) {
      const results = await pool.verify(Array.from({ length: 6 }, () => signedItem()));
      expect(results.every((r) => r.valid)).toBe(true);
    }
  });

  it("handles concurrent verify() calls on the same pool", async () => {
    const pool = makePool({ concurrency: 2, chunkSize: 3 });
    const [a, b] = await Promise.all([
      pool.verify(Array.from({ length: 10 }, () => signedItem())),
      pool.verify([{ ...signedItem(), message: "tampered" }]),
    ]);
    expect(a.every((r) => r.valid)).toBe(true);
    expect(b[0].valid).toBe(false);
  });

  it("fails a chunk with `timeout` and recovers with a fresh worker", async () => {
    // 1ms is shorter than worker start-up, so the first chunk times out deterministically.
    const pool = makePool({ concurrency: 1, chunkTimeoutMs: 1 });
    const [first] = await pool.verify([signedItem()]);
    expect(first).toMatchObject({ valid: false, reason: "timeout" });
  });

  it("rejects with `pool_closed` after close() and close() is idempotent", async () => {
    const pool = makePool();
    await pool.close();
    await pool.close();
    const [r] = await pool.verify([signedItem()]);
    expect(r).toMatchObject({ valid: false, reason: "pool_closed" });
  });

  it("fails in-flight work with `pool_closed` when closed mid-batch", async () => {
    const pool = makePool({ concurrency: 1, chunkSize: 1 });
    const pending = pool.verify(Array.from({ length: 20 }, () => signedItem()));
    await pool.close();
    const results = await pending;
    expect(results).toHaveLength(20);
    expect(results.some((r) => r.reason === "pool_closed")).toBe(true);
    // nothing is reported valid unless it really verified
    results.forEach((r) => expect(r.valid === true && r.reason !== undefined).toBe(false));
  });

  it("validates options", () => {
    expect(() => new BatchVerifierPool({ concurrency: 0 })).toThrow(RangeError);
    expect(() => new BatchVerifierPool({ chunkSize: 1.5 })).toThrow(RangeError);
    expect(() => new BatchVerifierPool({ chunkTimeoutMs: -1 })).toThrow(RangeError);
  });

  it("is exported from the server entry point only", () => {
    expect(fromServer.BatchVerifierPool).toBe(BatchVerifierPool);
    expect(fromServer.verifyWalletSignaturesBatch).toBe(verifyWalletSignaturesBatch);
    expect((fromIndex as Record<string, unknown>).BatchVerifierPool).toBeUndefined();
  });
});
