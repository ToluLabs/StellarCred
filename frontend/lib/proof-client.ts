// Main-thread client for the dedicated prover worker.
//
// Callers ask for a proof and get a promise; everything heavy happens in
// lib/proof-worker.ts. This module owns the worker's lifecycle, the job table,
// progress fan-out, and cancellation across the worker boundary.
//
// There is always a fallback: when Web Workers are unavailable (jsdom under
// Vitest, a `new Worker` blocked by CSP, or a worker script that failed to
// load) proving runs inline on the main thread through the exact same
// lib/proof.ts engine the worker uses. The result, the progress callbacks and
// the error shapes are identical — only the thread differs — so no caller has
// to know which path it got.

import type { GeneratedProof, ProverCircuit } from "./proof";
import type {
  ProofJobRequest,
  ProofStage,
  ProofWorkerCommand,
  ProofWorkerEvent,
} from "./proof-protocol";

export type { ProofJobRequest, ProofStage };

export interface ProveOptions {
  /** Aborting this cancels the job — inside the worker, not just locally. */
  signal?: AbortSignal;
  /** Called for each stage the worker reports, on the main thread. */
  onProgress?: (stage: ProofStage) => void;
}

interface ProofJob {
  jobId: number;
  request: ProofJobRequest;
  options: ProveOptions;
  resolve: (proof: GeneratedProof) => void;
  reject: (err: unknown) => void;
  settled: boolean;
}

let worker: Worker | null = null;
/** Set once the worker path is known unusable; never retried for this page load. */
let workerUnavailable = false;
let nextJobId = 1;
let loggedReady = false;
const jobs = new Map<number, ProofJob>();

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** Rebuild an Error from the name/message pair the worker sent back. */
function reviveError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** True when proving can (and will) happen in a worker. */
export function isProverWorkerAvailable(): boolean {
  return !workerUnavailable && typeof Worker !== "undefined";
}

function send(command: ProofWorkerCommand): void {
  worker?.postMessage(command);
}

function onWorkerMessage(event: MessageEvent<ProofWorkerEvent>): void {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  switch (msg.event) {
    case "ready": {
      if (!loggedReady) {
        loggedReady = true;
        // Read from inside the worker realm: this is the cross-origin
        // isolation the multithreaded bb.js path depends on.
        console.info(
          `[proof] prover worker ready — crossOriginIsolated=${msg.crossOriginIsolated}, ` +
            `hardwareConcurrency=${msg.hardwareConcurrency}`,
        );
      }
      return;
    }

    case "progress": {
      const job = jobs.get(msg.jobId);
      if (!job || job.settled) return;
      job.options.onProgress?.(msg.stage);
      return;
    }

    case "result": {
      const job = jobs.get(msg.jobId);
      if (!job || job.settled) return;
      settle(job, () => job.resolve({ proof: msg.proof, publicInputs: msg.publicInputs }));
      return;
    }

    case "error": {
      const job = jobs.get(msg.jobId);
      if (!job || job.settled) return;
      settle(job, () => job.reject(reviveError(msg.name, msg.message)));
      return;
    }

    case "done":
      // warm/destroy acknowledgements. Both are fire-and-forget by design, so
      // there is nothing waiting on them; the worker is allowed to outlive any
      // caller that asked for them.
      return;
  }
}

function onWorkerError(): void {
  // The worker script failed to load, or something threw outside a job's own
  // try/catch. Nothing more will arrive from it: retire the worker path for
  // the rest of this page load (re-creating it would just fail the same way)
  // and replay every in-flight job inline so the user still gets a proof.
  const pending = Array.from(jobs.values());
  workerUnavailable = true;
  retireWorker();
  console.warn(
    "[proof] prover worker unavailable — falling back to main-thread proving for this session.",
  );
  for (const job of pending) {
    if (job.settled) continue;
    jobs.delete(job.jobId);
    proveInline(job.request, job.options).then(job.resolve, job.reject);
  }
}

/** Tears the worker down without replaying anything (unmount / tab close). */
function retireWorker(): void {
  const active = worker;
  worker = null;
  if (!active) return;
  active.onmessage = null;
  active.onerror = null;
  active.onmessageerror = null;
  active.terminate();
}

// ── Worker loading ──────────────────────────────────────────────────────────
// The worker is a real file at /workers/proof-worker.js, bundled from
// lib/proof-worker.ts by scripts/build-proof-worker.mjs on predev/prebuild
// (the same arrangement this repo already uses for bb.js in /public/bb — see
// the comment at the top of that script for why a webpack-bundled worker chunk
// doesn't work under Next's App Router). Same origin, so the CSP's
// `script-src 'self'` covers it; a blob: worker would not be.
const PROOF_WORKER_URL = "/workers/proof-worker.js";

function getWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    workerUnavailable = true;
    return null;
  }
  try {
    const next = new Worker(PROOF_WORKER_URL, { type: "module" });
    next.onmessage = onWorkerMessage;
    next.onerror = onWorkerError;
    next.onmessageerror = onWorkerError;
    worker = next;
    return next;
  } catch (err) {
    console.warn("[proof] could not start the prover worker; proving inline.", err);
    workerUnavailable = true;
    return null;
  }
}

function settle(job: ProofJob, apply: () => void): void {
  if (job.settled) return;
  job.settled = true;
  jobs.delete(job.jobId);
  apply();
}

/**
 * The inline engine is imported lazily. On the worker path — the only path any
 * browser in production takes — lib/proof.ts is already bundled into the
 * worker, so pulling it into the route chunk a second time would be pure
 * deadweight. It is only fetched on the fallback path, where the browser has
 * already proved it cannot load the worker.
 */
type ProofEngine = typeof import("./proof");
let proofEngine: ProofEngine | null = null;

async function loadProofEngine(): Promise<ProofEngine> {
  if (!proofEngine) proofEngine = await import(/* webpackChunkName: "proof-engine" */ "./proof");
  return proofEngine;
}

/**
 * The main-thread path: identical orchestration to the worker's, minus the
 * thread. Used when workers are unavailable and to replay jobs when a worker
 * dies.
 */
async function proveInline(
  request: ProofJobRequest,
  options: ProveOptions,
): Promise<GeneratedProof> {
  const engine = await loadProofEngine();
  const { signal } = options;
  if (signal?.aborted) throw abortError();

  options.onProgress?.("witness");
  const witness = request.aggregate
    ? await engine.computeAggregateWitness(request.aggregate, signal)
    : await engine.computeWitness(request.credentialType, request.credential ?? {}, signal);
  if (signal?.aborted) throw abortError();

  return engine.proveWithBackend(request.credentialType, witness, signal, (stage) => {
    if (!signal?.aborted) options.onProgress?.(stage);
  });
}

function proveInWorker(
  active: Worker,
  request: ProofJobRequest,
  options: ProveOptions,
): Promise<GeneratedProof> {
  return new Promise<GeneratedProof>((resolve, reject) => {
    const jobId = nextJobId++;
    const job: ProofJob = { jobId, request, options, resolve, reject, settled: false };
    jobs.set(jobId, job);

    // The caller's AbortSignal cannot cross the boundary, so it is translated
    // into a cancel command: the worker aborts the witness fetch and destroys
    // the backend, which is what actually stops bb.js mid-proof. Locally the
    // promise rejects with the same AbortError the inline path throws, so
    // callers see one behaviour regardless of which path ran.
    const onAbort = () => {
      settle(job, () => {
        active.postMessage({ command: "cancel", jobId });
        reject(abortError());
      });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    active.postMessage({ command: "prove", jobId, request });
  });
}

/**
 * Generate a proof off the main thread.
 *
 * Progress arrives via `options.onProgress`; cancelling `options.signal`
 * cancels the work in the worker. Falls back to inline proving when workers
 * are unavailable.
 */
export function proveOffMainThread(
  request: ProofJobRequest,
  options: ProveOptions = {},
): Promise<GeneratedProof> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  const active = getWorker();
  if (!active) return proveInline(request, options);
  return proveInWorker(active, request, options);
}

/**
 * Construct a backend ahead of the first prove click, in the worker (so the
 * bytecode fetch and wasm init don't touch the UI thread either). Never
 * throws; failures are logged where they happen.
 */
export function warmProver(credentialType: ProverCircuit): void {
  const active = getWorker();
  if (!active) {
    void loadProofEngine().then((engine) => engine.warmBackend(credentialType));
    return;
  }
  send({ command: "warm", jobId: nextJobId++, credentialType });
}

/**
 * Drop everything the prover holds — the worker itself (and with it every
 * cached backend and its wasm memory), plus any inline-fallback backends.
 * Safe to call repeatedly and when nothing was ever started.
 */
export function releaseProver(): void {
  const pending = Array.from(jobs.values());
  retireWorker();
  for (const job of pending) {
    settle(job, () => job.reject(abortError()));
  }
  // Only the fallback path ever creates inline backends, so only then is there
  // anything here to tear down; the worker's were released with terminate().
  if (proofEngine) void proofEngine.destroyAllBackends();
}
