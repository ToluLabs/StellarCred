// Coverage for the prover worker boundary: lib/proof-client.ts (main thread)
// driving lib/proof-worker.ts (worker thread) over the message protocol in
// lib/proof-protocol.ts.
//
// Both sides run for real here — a fake `Worker` global wires the client's
// postMessage straight into the worker module's own `createProverWorker`
// handler, and the worker's replies are delivered back asynchronously, exactly
// like the browser's message queue. Only the two things that genuinely cannot
// run under jsdom are mocked: the witness fetch and the bb.js backend
// (lib/proof.ts), which proof.test.ts covers against the real cache.
//
// This is what makes the cancellation/progress guarantees testable without a
// browser: they are properties of the protocol, not of bb.js.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createProverWorker } from "../proof-worker";
import type { ProofWorkerCommand, ProofWorkerEvent } from "../proof-protocol";
import type { GeneratedProof } from "../proof";

const {
  computeWitness,
  computeAggregateWitness,
  proveWithBackend,
  warmBackend,
  destroyBackend,
  destroyAllBackends,
} = vi.hoisted(() => ({
  computeWitness: vi.fn(),
  computeAggregateWitness: vi.fn(),
  proveWithBackend: vi.fn(),
  warmBackend: vi.fn(),
  destroyBackend: vi.fn().mockResolvedValue(undefined),
  destroyAllBackends: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../proof", () => ({
  computeWitness,
  computeAggregateWitness,
  proveWithBackend,
  warmBackend,
  destroyBackend,
  destroyAllBackends,
}));

const PROOF: GeneratedProof = {
  proof: new Uint8Array([1, 2, 3, 4]),
  publicInputs: new Uint8Array([9, 9]),
};

/**
 * Stand-in for a real dedicated worker: routes the client's commands into the
 * actual worker implementation and posts the worker's replies back on a
 * microtask, so nothing resolves synchronously the way an in-process call
 * would.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  /** Set to simulate a worker chunk that fails to load. */
  static failOnConstruct = false;

  onmessage: ((event: MessageEvent<ProofWorkerEvent>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;

  /** Every command the main thread sent, in order. */
  commands: ProofWorkerCommand[] = [];
  /** Transfer lists the worker used, in order (undefined when it didn't). */
  transfers: Array<readonly Transferable[] | undefined> = [];
  terminated = false;

  private prover = createProverWorker({
    postMessage: (message, transfer) => {
      this.transfers.push(transfer);
      const delivered = cloneMessage(message);
      // The real boundary is asynchronous; keep it that way.
      queueMicrotask(() => {
        this.onmessage?.({ data: delivered } as MessageEvent<ProofWorkerEvent>);
      });
    },
  });

  constructor(
    readonly url: URL | string,
    readonly options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
    if (FakeWorker.failOnConstruct) {
      // Fires after the client has attached its handlers (it does so
      // synchronously, right after construction).
      queueMicrotask(() => this.onerror?.(new Event("error")));
    }
  }

  postMessage(command: ProofWorkerCommand): void {
    this.commands.push(command);
    this.prover.handleCommand(command);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Commands of one kind, for readable assertions. */
  sent(kind: ProofWorkerCommand["command"]): ProofWorkerCommand[] {
    return this.commands.filter((c) => c.command === kind);
  }
}

/** Emulates the structured-clone boundary for the shapes this protocol uses. */
function cloneMessage(message: ProofWorkerEvent): ProofWorkerEvent {
  if (message.event === "result") {
    return {
      ...message,
      proof: new Uint8Array(message.proof),
      publicInputs: new Uint8Array(message.publicInputs),
    };
  }
  return { ...message };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Fresh module registry per test: proof-client.ts holds module-level worker
// state (the worker instance, the job table, the "worker unavailable" flag),
// and these tests deliberately exercise the paths that flip it.
async function loadClient() {
  return import("../proof-client");
}

beforeEach(() => {
  vi.resetModules();
  FakeWorker.instances = [];
  FakeWorker.failOnConstruct = false;
  for (const fn of [
    computeWitness,
    computeAggregateWitness,
    proveWithBackend,
    warmBackend,
    destroyBackend,
    destroyAllBackends,
  ]) {
    fn.mockReset();
  }
  computeWitness.mockResolvedValue(new Uint8Array([0xde, 0xad]));
  computeAggregateWitness.mockResolvedValue(new Uint8Array([0xbe, 0xef]));
  proveWithBackend.mockResolvedValue(PROOF);
  destroyBackend.mockResolvedValue(undefined);
  destroyAllBackends.mockResolvedValue(undefined);
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prover worker: happy path", () => {
  it("runs the whole proof in a worker and resolves with the proof bytes", async () => {
    const { proveOffMainThread } = await loadClient();

    const result = await proveOffMainThread({
      credentialType: "age",
      credential: { value: "1995-06-15" },
    });

    expect(Array.from(result.proof)).toEqual([1, 2, 3, 4]);
    expect(Array.from(result.publicInputs)).toEqual([9, 9]);
    expect(computeWitness).toHaveBeenCalledWith(
      "age",
      { value: "1995-06-15" },
      expect.any(AbortSignal),
    );
    expect(proveWithBackend).toHaveBeenCalledWith(
      "age",
      new Uint8Array([0xde, 0xad]),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("spawns exactly one worker and sends the job across the boundary", async () => {
    const { proveOffMainThread } = await loadClient();

    await proveOffMainThread({ credentialType: "age", credential: { value: "x" } });

    expect(FakeWorker.instances).toHaveLength(1);
    const [worker] = FakeWorker.instances;
    // A real, same-origin, statically-served file: never a blob: URL, which
    // the app's `script-src 'self'` CSP would block.
    expect(worker.url).toBe("/workers/proof-worker.js");
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.sent("prove")).toEqual([
      {
        command: "prove",
        jobId: expect.any(Number),
        request: { credentialType: "age", credential: { value: "x" } },
      },
    ]);
  });

  it("posts every proving stage back to the UI as progress", async () => {
    proveWithBackend.mockImplementation((_type, _witness, _signal, onStep) => {
      onStep?.("circuit");
      onStep?.("proof");
      return Promise.resolve(PROOF);
    });
    const { proveOffMainThread } = await loadClient();
    const stages: string[] = [];

    await proveOffMainThread(
      { credentialType: "age", credential: {} },
      { onProgress: (stage) => stages.push(stage) },
    );

    // witness first (from the worker itself), then bb.js's own stages.
    expect(stages).toEqual(["witness", "circuit", "proof"]);
  });

  it("transfers the proof buffers instead of making the main thread copy them", async () => {
    const { proveOffMainThread } = await loadClient();

    await proveOffMainThread({ credentialType: "age", credential: {} });

    const [worker] = FakeWorker.instances;
    const transferred = worker.transfers.filter((t): t is readonly Transferable[] => !!t);
    expect(transferred).toHaveLength(1);
    expect(transferred[0]).toHaveLength(2);
    expect(transferred[0][0]).toBe(PROOF.proof.buffer);
    expect(transferred[0][1]).toBe(PROOF.publicInputs.buffer);
  });

  it("copies instead of transferring when the bytes are a view into a larger buffer", async () => {
    // A view with a byteOffset must never be transferred as-is: postMessage
    // would hand over the whole underlying buffer, extra bytes included.
    const backing = new Uint8Array([7, 7, 1, 2, 3, 4]);
    proveWithBackend.mockResolvedValue({
      proof: backing.subarray(2),
      publicInputs: new Uint8Array([9, 9]),
    });
    const { proveOffMainThread } = await loadClient();

    const result = await proveOffMainThread({ credentialType: "age", credential: {} });

    expect(Array.from(result.proof)).toEqual([1, 2, 3, 4]);
    const [worker] = FakeWorker.instances;
    const transferred = worker.transfers.filter((t): t is readonly Transferable[] => !!t)[0];
    expect(transferred[0]).not.toBe(backing.buffer);
  });

  it("routes an aggregate job through the aggregate witness path", async () => {
    const { proveOffMainThread } = await loadClient();
    const aggregate = {
      kyc: { value: "1", salt: "2", sig: [1], commitment: "3", issuerPubX: [1], issuerPubY: [2] },
      age: { date_of_birth: "4", salt: "5", sig: [2], commitment: "6", issuerPubX: [3], issuerPubY: [4] },
    };

    await proveOffMainThread({ credentialType: "aggregate", aggregate });

    expect(computeAggregateWitness).toHaveBeenCalledWith(aggregate, expect.any(AbortSignal));
    expect(computeWitness).not.toHaveBeenCalled();
    expect(proveWithBackend).toHaveBeenCalledWith(
      "aggregate",
      new Uint8Array([0xbe, 0xef]),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it("reuses one worker across sequential and concurrent proofs", async () => {
    const { proveOffMainThread } = await loadClient();

    await proveOffMainThread({ credentialType: "age", credential: {} });
    await Promise.all([
      proveOffMainThread({ credentialType: "age", credential: {} }),
      proveOffMainThread({ credentialType: "kyc", credential: {} }),
    ]);

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].sent("prove")).toHaveLength(3);
  });
});

describe("prover worker: cancellation across the boundary", () => {
  it("sends a cancel command and rejects with AbortError when the caller aborts", async () => {
    let jobSignal: AbortSignal | undefined;
    proveWithBackend.mockImplementation(
      (_type, _witness, signal) =>
        new Promise<GeneratedProof>((_resolve, reject) => {
          jobSignal = signal;
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const { proveOffMainThread } = await loadClient();
    const controller = new AbortController();

    const promise = proveOffMainThread(
      { credentialType: "age", credential: {} },
      { signal: controller.signal },
    );
    await flush(); // let the job reach the worker and start proving

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    const [worker] = FakeWorker.instances;
    expect(worker.sent("cancel")).toHaveLength(1);
    // The AbortSignal the worker handed to the engine really was aborted —
    // that is what stops the witness fetch and destroys the WASM backend.
    expect(jobSignal?.aborted).toBe(true);
  });

  it("rejects immediately, without touching the worker, when the signal is already aborted", async () => {
    const { proveOffMainThread } = await loadClient();
    const controller = new AbortController();
    controller.abort();

    await expect(
      proveOffMainThread({ credentialType: "age", credential: {} }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(computeWitness).not.toHaveBeenCalled();
  });

  it("ignores a cancel that arrives after the job already finished", async () => {
    const { proveOffMainThread } = await loadClient();
    const controller = new AbortController();

    const result = await proveOffMainThread(
      { credentialType: "age", credential: {} },
      { signal: controller.signal },
    );
    controller.abort();
    await flush();

    expect(Array.from(result.proof)).toEqual([1, 2, 3, 4]);
    expect(FakeWorker.instances[0].sent("cancel")).toHaveLength(0);
  });

  it("releaseProver terminates the worker and rejects whatever is in flight", async () => {
    proveWithBackend.mockImplementation(
      () => new Promise<GeneratedProof>(() => {}), // never settles
    );
    const { proveOffMainThread, releaseProver } = await loadClient();

    const promise = proveOffMainThread({ credentialType: "age", credential: {} });
    await flush();
    releaseProver();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.instances[0].terminated).toBe(true);
    // The worker's own backends died with terminate(). The inline engine is
    // loaded lazily, so on the worker path it was never imported at all -- and
    // with nothing loaded there is no wasm to destroy.
    expect(destroyAllBackends).not.toHaveBeenCalled();
  });
});

describe("prover worker: failures", () => {
  it("surfaces a witness failure with its original message and name", async () => {
    computeWitness.mockRejectedValue(new Error("Witness generation failed: 500 boom"));
    const { proveOffMainThread } = await loadClient();

    await expect(
      proveOffMainThread({ credentialType: "age", credential: {} }),
    ).rejects.toThrow("Witness generation failed: 500 boom");
  });

  it("surfaces a non-Error rejection without losing it", async () => {
    computeWitness.mockRejectedValue("string failure");
    const { proveOffMainThread } = await loadClient();

    await expect(proveOffMainThread({ credentialType: "age", credential: {} })).rejects.toThrow(
      "string failure",
    );
  });

  it("keeps the worker alive after a failed job so the next proof still works", async () => {
    computeWitness.mockRejectedValueOnce(new Error("transient"));
    const { proveOffMainThread } = await loadClient();

    await expect(proveOffMainThread({ credentialType: "age", credential: {} })).rejects.toThrow(
      "transient",
    );
    const result = await proveOffMainThread({ credentialType: "age", credential: {} });

    expect(Array.from(result.proof)).toEqual([1, 2, 3, 4]);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].terminated).toBe(false);
  });

  it("replays an in-flight job inline when the worker script fails to load", async () => {
    FakeWorker.failOnConstruct = true;
    const { proveOffMainThread, isProverWorkerAvailable } = await loadClient();

    const result = await proveOffMainThread(
      { credentialType: "age", credential: {} },
      { onProgress: () => {} },
    );

    // The user still gets a proof, from the main-thread fallback.
    expect(Array.from(result.proof)).toEqual([1, 2, 3, 4]);
    // ...and the worker path is retired for the rest of the page load, rather
    // than being retried (and failing again) on the next proof.
    expect(isProverWorkerAvailable()).toBe(false);
    expect(FakeWorker.instances[0].terminated).toBe(true);

    const second = await proveOffMainThread({ credentialType: "age", credential: {} });
    expect(Array.from(second.proof)).toEqual([1, 2, 3, 4]);
    expect(FakeWorker.instances).toHaveLength(1); // no second worker spawned
    // 3 witness computations: the worker's own attempt before it died, the
    // inline replay of that same job, and the second proof. The replay starts
    // the job over from the witness stage -- there is nothing to resume from a
    // worker that never loaded.
    expect(computeWitness).toHaveBeenCalledTimes(3);
  });
});

describe("prover worker: fallback to the main thread", () => {
  it("proves inline, with the same progress and result, when Worker is unavailable", async () => {
    vi.stubGlobal("Worker", undefined); // jsdom, SSR, or a locked-down browser
    proveWithBackend.mockImplementation((_type, _witness, _signal, onStep) => {
      onStep?.("circuit");
      onStep?.("proof");
      return Promise.resolve(PROOF);
    });
    const { proveOffMainThread, isProverWorkerAvailable } = await loadClient();
    const stages: string[] = [];

    expect(isProverWorkerAvailable()).toBe(false);
    const result = await proveOffMainThread(
      { credentialType: "age", credential: { value: "x" } },
      { onProgress: (stage) => stages.push(stage) },
    );

    expect(Array.from(result.proof)).toEqual([1, 2, 3, 4]);
    expect(stages).toEqual(["witness", "circuit", "proof"]);
    expect(computeWitness).toHaveBeenCalledTimes(1);
    expect(proveWithBackend).toHaveBeenCalledTimes(1);
  });

  it("honours cancellation on the inline path too", async () => {
    vi.stubGlobal("Worker", undefined);
    proveWithBackend.mockImplementation(
      (_type, _witness, signal) =>
        new Promise<GeneratedProof>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const { proveOffMainThread } = await loadClient();
    const controller = new AbortController();

    const promise = proveOffMainThread(
      { credentialType: "age", credential: {} },
      { signal: controller.signal },
    );
    await flush();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("warms and releases through lib/proof when there is no worker", async () => {
    vi.stubGlobal("Worker", undefined);
    const { warmProver, releaseProver } = await loadClient();

    // No worker, so the inline engine is what warms -- but it is imported
    // lazily, so the call has to be awaited before it lands.
    warmProver("age");
    await flush();
    expect(warmBackend).toHaveBeenCalledWith("age");

    // Now that the engine is loaded, release must tear its backends down.
    releaseProver();
    expect(destroyAllBackends).toHaveBeenCalled();
  });
});

describe("prover worker: warm / destroy commands", () => {
  it("sends warm to the worker instead of constructing on the main thread", async () => {
    const { warmProver } = await loadClient();

    warmProver("age");
    await flush();

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].sent("warm")).toEqual([
      { command: "warm", jobId: expect.any(Number), credentialType: "age" },
    ]);
    expect(warmBackend).toHaveBeenCalledWith("age");
    // Warming must never construct a backend on the UI thread.
    expect(computeWitness).not.toHaveBeenCalled();
  });
});
