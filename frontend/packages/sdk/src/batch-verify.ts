/**
 * Batch proof verification on a pool of worker threads (#1063).
 *
 * Verifying thousands of wallet-signed presentations one by one on the main
 * thread blocks the Node.js event loop. `BatchVerifierPool` spreads the
 * Ed25519 signature checks across `worker_threads`, one chunk per worker, and
 * returns one result per input in input order.
 *
 * Node.js only — exported from `@stellarcred/sdk/server`, not the browser
 * entry point. Results are identical to calling `verifyWalletSignature` on
 * every item; this module only changes *where* the work runs.
 *
 * Workers use `node:crypto` only (no dependencies), so the inline worker
 * source resolves the same way from the CJS and ESM builds. Wallet keys are
 * decoded on the calling thread, which is cheap next to the verification.
 */

import { Buffer } from "buffer";
import { availableParallelism, cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { StrKey } from "@stellar/stellar-sdk";

/** One presentation to verify: `signature` is an Ed25519 signature over `message` by `wallet`. */
export interface BatchVerifyItem {
  /** Stellar public key (G...) that allegedly signed `message`. */
  wallet: string;
  message: string | Uint8Array;
  /** 64-byte signature as hex, base64, or raw bytes (same encodings as `verifyWalletSignature`). */
  signature: string | Uint8Array;
}

export type BatchVerifyFailureReason =
  "invalid_wallet" | "invalid_signature" | "worker_error" | "timeout" | "pool_closed";

export interface BatchVerifyResult {
  /** Position of the item in the input array. */
  index: number;
  wallet: string;
  /** True only if the signature verified. Never true when `reason` is set. */
  valid: boolean;
  /** Why `valid` is false. Absent on success; `invalid_signature` also covers a well-formed but wrong signature. */
  reason?: BatchVerifyFailureReason;
}

export interface BatchVerifierOptions {
  /** Worker threads to use. Defaults to the available CPU cores minus one (min 1). */
  concurrency?: number;
  /** Items sent to a worker per message. Defaults to 64. */
  chunkSize?: number;
  /** Per-chunk time limit in ms. A stuck worker is terminated and its chunk fails with `timeout`. Defaults to 30 000. */
  chunkTimeoutMs?: number;
}

const DEFAULT_CHUNK_SIZE = 64;
const DEFAULT_CHUNK_TIMEOUT_MS = 30_000;

// Plain CommonJS so it can be loaded with `eval: true` from any build format.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { verify, createPublicKey } = require("node:crypto");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
parentPort.on("message", ({ id, items }) => {
  const results = items.map(({ key, message, signature }) => {
    try {
      const publicKey = createPublicKey({
        key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(key)]),
        format: "der",
        type: "spki",
      });
      return verify(null, Buffer.from(message), publicKey, Buffer.from(signature));
    } catch {
      return false;
    }
  });
  parentPort.postMessage({ id, results });
});
`;

interface Chunk {
  payload: { key: Uint8Array; message: Uint8Array; signature: Uint8Array }[];
  resolve: (outcome: boolean[] | BatchVerifyFailureReason) => void;
}

interface Slot {
  worker: Worker;
  current?: { id: number; chunk: Chunk; timer: ReturnType<typeof setTimeout> };
}

function defaultConcurrency(): number {
  const cores = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
  return Math.max(1, cores - 1);
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer (received ${value}).`);
  }
  return value;
}

function decodeSignature(signature: string | Uint8Array): Buffer {
  if (typeof signature !== "string") return Buffer.from(signature);
  const clean = signature.trim();
  return /^[0-9a-fA-F]{128}$/.test(clean)
    ? Buffer.from(clean, "hex")
    : Buffer.from(clean, "base64");
}

/**
 * A reusable pool of verification workers. Create one, call {@link verify} as
 * often as needed, and {@link close} it when done. Workers start lazily and are
 * replaced if one crashes or times out.
 */
export class BatchVerifierPool {
  private readonly concurrency: number;
  private readonly chunkSize: number;
  private readonly chunkTimeoutMs: number;
  private readonly slots: Slot[] = [];
  private readonly queue: Chunk[] = [];
  private nextId = 0;
  private closed = false;

  constructor(options: BatchVerifierOptions = {}) {
    this.concurrency = positiveInt(options.concurrency, defaultConcurrency(), "concurrency");
    this.chunkSize = positiveInt(options.chunkSize, DEFAULT_CHUNK_SIZE, "chunkSize");
    this.chunkTimeoutMs = positiveInt(
      options.chunkTimeoutMs,
      DEFAULT_CHUNK_TIMEOUT_MS,
      "chunkTimeoutMs",
    );
  }

  /** Verifies every item and resolves with one result per input, in input order. Never rejects for bad items. */
  async verify(items: readonly BatchVerifyItem[]): Promise<BatchVerifyResult[]> {
    const results: BatchVerifyResult[] = items.map((item, index) => ({
      index,
      wallet: typeof item?.wallet === "string" ? item.wallet : "",
      valid: false,
    }));
    const fail = (index: number, reason: BatchVerifyFailureReason) => {
      results[index].valid = false;
      results[index].reason = reason;
    };

    if (this.closed) {
      for (let i = 0; i < items.length; i++) fail(i, "pool_closed");
      return results;
    }

    // Decode on this thread; anything malformed is rejected without a worker round trip.
    const pending: {
      index: number;
      key: Uint8Array;
      message: Uint8Array;
      signature: Uint8Array;
    }[] = [];
    items.forEach((item, index) => {
      let key: Buffer;
      try {
        key = StrKey.decodeEd25519PublicKey(item.wallet);
      } catch {
        return fail(index, "invalid_wallet");
      }
      let signature: Buffer;
      let message: Buffer;
      try {
        message =
          typeof item.message === "string"
            ? Buffer.from(item.message, "utf8")
            : Buffer.from(item.message);
        signature = decodeSignature(item.signature);
      } catch {
        return fail(index, "invalid_signature");
      }
      if (signature.length !== 64) return fail(index, "invalid_signature");
      pending.push({ index, key, message, signature });
    });

    const jobs: Promise<void>[] = [];
    for (let start = 0; start < pending.length; start += this.chunkSize) {
      const slice = pending.slice(start, start + this.chunkSize);
      jobs.push(
        new Promise<void>((done) => {
          this.queue.push({
            payload: slice.map(({ key, message, signature }) => ({ key, message, signature })),
            resolve: (outcome) => {
              slice.forEach(({ index }, i) => {
                if (typeof outcome === "string") return fail(index, outcome);
                if (outcome[i] === true) results[index].valid = true;
                else fail(index, "invalid_signature");
              });
              done();
            },
          });
        }),
      );
    }
    this.pump();
    await Promise.all(jobs);
    return results;
  }

  /** Terminates all workers. Queued and in-flight chunks fail with `pool_closed`. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const chunk of this.queue.splice(0)) chunk.resolve("pool_closed");
    await Promise.all(this.slots.splice(0).map((slot) => this.retire(slot, "pool_closed")));
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => !s.current);
      if (!slot && this.slots.length < this.concurrency) {
        slot = this.spawn();
      }
      if (!slot) return;
      this.dispatch(slot, this.queue.shift() as Chunk);
    }
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    const slot: Slot = { worker };
    worker.unref(); // an idle pool must not keep the process alive
    worker.on("message", ({ id, results }: { id: number; results: boolean[] }) => {
      if (slot.current?.id !== id) return;
      this.settle(slot, results);
      this.pump();
    });
    worker.on("error", () => this.replace(slot, "worker_error"));
    worker.on("exit", () => this.replace(slot, "worker_error"));
    this.slots.push(slot);
    return slot;
  }

  private dispatch(slot: Slot, chunk: Chunk): void {
    const id = this.nextId++;
    const timer = setTimeout(() => this.replace(slot, "timeout"), this.chunkTimeoutMs);
    slot.current = { id, chunk, timer };
    slot.worker.ref(); // keep the process alive while work is in flight
    slot.worker.postMessage({ id, items: chunk.payload });
  }

  private settle(slot: Slot, outcome: boolean[] | BatchVerifyFailureReason): void {
    const current = slot.current;
    if (!current) return;
    clearTimeout(current.timer);
    slot.current = undefined;
    slot.worker.unref();
    current.chunk.resolve(outcome);
  }

  /** Drops a dead or stuck worker, fails its chunk, and lets `pump` start a fresh one. */
  private replace(slot: Slot, reason: BatchVerifyFailureReason): void {
    const at = this.slots.indexOf(slot);
    if (at === -1) return; // already retired (e.g. error followed by exit)
    this.slots.splice(at, 1);
    void this.retire(slot, reason);
    if (!this.closed) this.pump();
  }

  private async retire(slot: Slot, reason: BatchVerifyFailureReason): Promise<void> {
    this.settle(slot, reason);
    try {
      await slot.worker.terminate();
    } catch {
      /* already gone */
    }
  }
}

/**
 * One-shot helper: verifies `items` on a temporary worker pool and tears it
 * down afterwards. Prefer {@link BatchVerifierPool} when verifying repeatedly.
 *
 * @example
 * ```ts
 * import { verifyWalletSignaturesBatch } from "@stellarcred/sdk/server";
 *
 * const results = await verifyWalletSignaturesBatch(presentations, { concurrency: 4 });
 * const rejected = results.filter((r) => !r.valid);
 * ```
 */
export async function verifyWalletSignaturesBatch(
  items: readonly BatchVerifyItem[],
  options: BatchVerifierOptions = {},
): Promise<BatchVerifyResult[]> {
  if (items.length === 0) return [];
  const pool = new BatchVerifierPool(options);
  try {
    return await pool.verify(items);
  } finally {
    await pool.close();
  }
}
