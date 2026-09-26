// Message protocol for the dedicated prover worker.
//
// Two modules speak this protocol:
//   • lib/proof-worker.ts — the worker itself (runs witness + proving).
//   • lib/proof-client.ts — the main-thread client that drives it.
//
// This file is deliberately **types-only**. Both sides import it with
// `import type`, so it is erased at compile time: it adds nothing to either
// bundle, and — more importantly — it cannot create a runtime import edge
// between the main thread and the worker chunk. Keep it that way: a value
// export here would pull this module (and whatever it imports) into both.

import type { AggregateInput, ProverCircuit } from "./proof";

/**
 * Proving stages, in the order the worker reports them. Mirrors the steps the
 * holder page's progress UI already renders, so the UI's state machine needs
 * no new vocabulary to consume worker progress.
 */
export type ProofStage = "witness" | "circuit" | "proof";

/** Which circuit to run, plus the private inputs it needs. */
export interface ProofJobRequest {
  /** Circuit id: a credential type, or `"aggregate"` for the multi-credential circuit. */
  credentialType: ProverCircuit;
  /** Full credential object. Required for single-credential proofs. */
  credential?: Record<string, unknown>;
  /** Inner credentials. Required when `credentialType` is `"aggregate"`. */
  aggregate?: AggregateInput;
}

/** main thread → worker. */
export type ProofWorkerCommand =
  /** Run a proof: witness generation followed by UltraHonk proving. */
  | { command: "prove"; jobId: number; request: ProofJobRequest }
  /** Construct (and cache) a backend in the background, without proving. */
  | { command: "warm"; jobId: number; credentialType: ProverCircuit }
  /** Tear down one cached backend, or all of them when `credentialType` is omitted. */
  | { command: "destroy"; jobId: number; credentialType?: ProverCircuit }
  /** Abort an in-flight job: cancels the witness fetch and destroys the backend. */
  | { command: "cancel"; jobId: number };

/** worker → main thread. */
export type ProofWorkerEvent =
  /**
   * The worker script booted. Carries the isolation facts the multithreaded
   * bb.js path depends on, so the main thread can log/verify them from
   * *inside the worker realm* rather than inferring them from the page.
   */
  | {
      event: "ready";
      crossOriginIsolated: boolean;
      hardwareConcurrency: number;
    }
  /** A proving stage began. */
  | { event: "progress"; jobId: number; stage: ProofStage }
  /** The proof finished. `proof`/`publicInputs` arrive as transferred buffers. */
  | { event: "result"; jobId: number; proof: Uint8Array; publicInputs: Uint8Array }
  /** The job failed. `name`/`message` let the client rebuild a faithful Error. */
  | { event: "error"; jobId: number; name: string; message: string }
  /** A warm/destroy command finished. */
  | { event: "done"; jobId: number };
