// ── Dedicated prover worker ─────────────────────────────────────────────────
//
// Proving used to be orchestrated on the main thread: even though bb.js runs
// its heavy field arithmetic in its own worker pool, *this* side of the work
// stayed on the UI thread — decoding the witness hex from /api/witness,
// constructing the UltraHonk backend (bytecode fetch + wasm init), driving
// generateProof, and serializing 14.5 kB of proof + public inputs. That is
// enough main-thread work to visibly jank the progress UI mid-proof.
//
// So the whole orchestration now lives here, in a dedicated worker:
//
//   main thread                            prover worker (this file)
//   ───────────                            ─────────────────────────
//   { command: "prove", jobId, request } → witness fetch + hex decode
//                                          backend construction (cached)
//   ← { event: "progress", stage }         UltraHonk proving (bb.js)
//   ← { event: "result", proof, … }        proof serialization
//
// Cancellation crosses the boundary as `{ command: "cancel", jobId }`, which
// aborts the job's own AbortController: that aborts the witness fetch and
// destroys the WASM backend, exactly as the old main-thread AbortSignal did.
//
// Progress crosses back as `{ event: "progress", … }` messages, so the UI keeps
// updating from a thread that is doing nothing else.
//
// ── Cross-origin isolation ──────────────────────────────────────────────────
// A dedicated worker created by a crossOriginIsolated page is itself cross-
// origin isolated, so SharedArrayBuffer and `self.crossOriginIsolated` are
// available in here and bb.js takes the same multithreaded path it took on the
// main thread (lib/proof.ts reads `globalThis.crossOriginIsolated`, and bb.js
// internally does `typeof window !== "undefined" ? window : globalThis`). The
// `ready` event reports both values from *inside* this realm so the choice is
// verifiable from the console rather than assumed.
//
// ── Loading ─────────────────────────────────────────────────────────────────
// scripts/build-proof-worker.mjs bundles this file (plus lib/proof.ts) into
// public/workers/proof-worker.js on predev/prebuild, and lib/proof-client.ts
// starts it with `new Worker("/workers/proof-worker.js", { type: "module" })`.
// It is deliberately *not* a webpack worker chunk — Next's App Router rewrites
// app-graph modules into RSC client references, which empties the chunk; that
// script's header has the details. bb.js itself is still loaded as a native ES
// module from /public/bb with `webpackIgnore` (see lib/proof.ts), untouched by
// any bundler, so its prebuilt worker bundles keep working as they do today.

import {
  computeAggregateWitness,
  computeWitness,
  destroyAllBackends,
  destroyBackend,
  proveWithBackend,
  warmBackend,
} from "./proof";
import type {
  ProofJobRequest,
  ProofWorkerCommand,
  ProofWorkerEvent,
} from "./proof-protocol";

/**
 * The slice of `DedicatedWorkerGlobalScope` this module uses. Typed locally
 * rather than via `/// <reference lib="webworker" />`, because that reference
 * pulls in the whole webworker lib and collides with the app's `dom` lib
 * (duplicate `self`/`postMessage` declarations) during `tsc --noEmit`.
 */
interface ProverWorkerScope {
  postMessage(message: ProofWorkerEvent, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ProofWorkerCommand>) => void) | null;
  /** Exists only on a WorkerGlobalScope — used as the "am I the worker?" test. */
  importScripts?: (...urls: string[]) => void;
}

/** What the main-thread client is allowed to drive. */
export interface ProverWorker {
  handleCommand(command: ProofWorkerCommand): void;
}

/**
 * postMessage hands ownership of the *entire* ArrayBuffer to the receiving
 * side, so only a buffer whose bytes are exactly the payload may be
 * transferred. bb.js returns tight arrays, but if it ever hands back a view
 * into a larger buffer we copy first — still off the main thread, which is
 * where the cost matters.
 */
function transferable(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Builds a prover bound to `scope`. Factored out of the module-level worker
 * wiring so unit tests can drive the real command handling with a fake
 * postMessage sink instead of needing a browser worker.
 */
export function createProverWorker(scope: Pick<ProverWorkerScope, "postMessage">): ProverWorker {
  /** AbortController per in-flight job, so `cancel` can stop exactly one proof. */
  const jobs = new Map<number, AbortController>();

  function post(event: ProofWorkerEvent, transfer?: Transferable[]): void {
    scope.postMessage(event, transfer);
  }

  async function runProve(jobId: number, request: ProofJobRequest): Promise<void> {
    const controller = new AbortController();
    jobs.set(jobId, controller);
    const { signal } = controller;
    try {
      // Stage 1 — witness. The fetch (and the hex→bytes decode of its response)
      // happens in here, which is the point: both used to run on the UI thread.
      post({ event: "progress", jobId, stage: "witness" });
      const witness = request.aggregate
        ? await computeAggregateWitness(request.aggregate, signal)
        : await computeWitness(request.credentialType, request.credential ?? {}, signal);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");

      // Stage 2 — UltraHonk proving. `onStep` forwards bb.js's own stages
      // straight through to the UI as progress messages.
      const result = await proveWithBackend(request.credentialType, witness, signal, (stage) => {
        if (!signal.aborted) post({ event: "progress", jobId, stage });
      });

      const proof = transferable(result.proof);
      const publicInputs = transferable(result.publicInputs);
      post(
        { event: "result", jobId, proof, publicInputs },
        [proof.buffer as ArrayBuffer, publicInputs.buffer as ArrayBuffer],
      );
    } catch (err) {
      // Every failure — witness error, circuit-not-found, abort, wasm crash —
      // reaches the main thread as a structured error, never as an uncaught
      // rejection that would silently strand a pending promise over there.
      post({ event: "error", jobId, name: errorName(err), message: errorMessage(err) });
    } finally {
      jobs.delete(jobId);
    }
  }

  function runWarm(jobId: number, credentialType: ProofJobRequest["credentialType"]): void {
    try {
      // Fire-and-forget by design: warmBackend already swallows and logs its
      // own failures, and warming must never reject the caller.
      warmBackend(credentialType);
      post({ event: "done", jobId });
    } catch (err) {
      post({ event: "error", jobId, name: errorName(err), message: errorMessage(err) });
    }
  }

  async function runDestroy(jobId: number, credentialType?: ProofJobRequest["credentialType"]): Promise<void> {
    try {
      if (credentialType) {
        await destroyBackend(credentialType);
      } else {
        await destroyAllBackends();
      }
      post({ event: "done", jobId });
    } catch (err) {
      post({ event: "error", jobId, name: errorName(err), message: errorMessage(err) });
    }
  }

  return {
    handleCommand(command: ProofWorkerCommand): void {
      if (!command || typeof command !== "object") return;
      switch (command.command) {
        case "prove":
          void runProve(command.jobId, command.request);
          return;
        case "warm":
          runWarm(command.jobId, command.credentialType);
          return;
        case "destroy":
          void runDestroy(command.jobId, command.credentialType);
          return;
        case "cancel":
          // No-op when the job already finished — the main thread may cancel
          // (or unmount) a hair after the result crossed back.
          jobs.get(command.jobId)?.abort();
          return;
      }
    },
  };
}

// ── Worker entry point ──────────────────────────────────────────────────────
//
// Wired up only when this module *is* the script of a real dedicated worker:
// `importScripts` exists on WorkerGlobalScope and nowhere else, so this is
// false in the main-thread bundle (where this file is referenced only through
// `new URL(...)` and never executed) and false under jsdom, where unit tests
// import `createProverWorker` directly and must not touch the globals.
const scope = globalThis as unknown as ProverWorkerScope;

if (typeof scope.importScripts === "function" && typeof window === "undefined") {
  const prover = createProverWorker({
    postMessage: (message, transfer) => scope.postMessage(message, transfer),
  });
  scope.onmessage = (event: MessageEvent<ProofWorkerCommand>) => {
    prover.handleCommand(event.data);
  };
  // Announce readiness with the isolation facts bb.js's multithreaded path
  // depends on — logged by the client so a broken COOP/COEP deployment is
  // visible in the console instead of silently single-threading.
  scope.postMessage({
    event: "ready",
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
    hardwareConcurrency: globalThis.navigator?.hardwareConcurrency ?? 1,
  });
}
