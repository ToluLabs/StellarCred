"use client";

/**
 * useProofFlow — manages the state machine for a single credential's
 * proof generation and submission lifecycle.
 *
 * Stages: idle → witness → circuit → proof → generated → preflight → readyToSign → submitting → confirmed | error
 *
 * The witness/circuit/proof stages are reported by the dedicated prover
 * worker (lib/proof-client.ts) — the whole proof runs off the main thread,
 * so this hook only translates worker progress into UI state and keeps the
 * AbortSignal that cancels the job across the worker boundary.
 *
 * No exhaustive-deps hacks: every effect dependency is explicit and minimal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Credential } from "../credential";

import { proveOffMainThread } from "../proof-client";
import { withTimeout, ProofTimeoutError, DEFAULT_PROOF_TIMEOUT_MS } from "../proof-timeout";
import {
  submitProof as defaultSubmitProof,
  preflightSubmitProof,
  parseContractError,
  type ContractError,
  type FeeEstimate,
} from "../contracts";
import { credTtlSecs } from "../proof-helpers";
import { useProofTimeline } from "../useProofTimeline";
import { useToast } from "@/components/Toast";

export type Stage =
  | "idle"
  | "witness"
  | "circuit"
  | "proof"
  | "generated"
  | "preflight"
  | "readyToSign"
  | "submitting"
  | "confirmed"
  | "error";

export type ErrorPhase = "proving" | "preflight" | "submitting" | "timeout" | null;

/** Custom submission function signature — injected by the page for sponsored mode. */
export type SubmitFn = (params: {
  holder: string;
  issuerId: string;
  credentialType: string;
  proof: Uint8Array;
  publicInputs: Uint8Array;
  ttlSecs: number;
  vkVersion?: number;
}) => Promise<string>;

export function useProofFlow(
  cred: Credential | null,
  submitFn: SubmitFn = defaultSubmitProof,
) {
  const [stage, setStage] = useState<Stage>("idle");
  const [proof, setProof] = useState<{ proof: Uint8Array; publicInputs: Uint8Array } | null>(null);
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState<ContractError | null>(null);
  const [errorPhase, setErrorPhase] = useState<ErrorPhase>(null);
  /** Estimated on-chain fee reported by the preflight simulation. */
  const [fee, setFee] = useState<FeeEstimate | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The in-flight job's controller — aborting it cancels the work in the worker. */
  const abortRef = useRef<AbortController | null>(null);
  const toast = useToast();
  const { addEvent } = useProofTimeline(cred);

  // User-initiated cancel: aborts the proof inside the prover worker (witness
  // fetch cancelled, backend destroyed), not just this component's view of it.
  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Restart the "elapsed" clock for a new phase. Always clears the previous
  // interval first: the old two-stage flow assigned a second interval over
  // timerRef without clearing the witness one, so two intervals ticked the
  // same state for the rest of the proof.
  const startElapsedTimer = useCallback((from: number) => {
    if (timerRef.current) clearInterval(timerRef.current);
    setElapsed(0);
    timerRef.current = setInterval(
      () => setElapsed(Math.floor((Date.now() - from) / 1000)),
      1000,
    );
  }, []);
  const stopElapsedTimer = useCallback(() => {
    if (!timerRef.current) return;
    clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // ── Proof generation ───────────────────────────────────────────────────────
  // Fires automatically when `cred` changes (single dependency). Witness
  // generation and UltraHonk proving both run in the dedicated prover worker;
  // only progress messages come back, so the UI thread stays free to repaint
  // the progress bar and accept a cancel click.
  useEffect(() => {
    if (!cred) return;

    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setStage("witness");
    setProof(null);
    setTxHash("");
    setError(null);
    setErrorPhase(null);
    setFee(null);

    // The worker's first non-witness progress message also restarts the
    // elapsed clock, matching the previous flow's per-stage timing.
    let provingStarted = false;

    toast.info(`Generating proof for ${cred.title}…`);

    (async () => {
      try {
        setStage("witness");
        startElapsedTimer(Date.now());

        // withTimeout keeps the deadline on this side of the boundary: when it
        // fires it aborts the signal, which cancels the worker's job, and the
        // rejection is surfaced as ProofTimeoutError.
        const result = await withTimeout(
          (sig) =>
            proveOffMainThread(
              {
                credentialType: cred.type,
                credential: cred as unknown as Record<string, unknown>,
              },
              {
                signal: sig,
                onProgress: (workerStage) => {
                  if (sig.aborted) return;
                  if (workerStage !== "witness" && !provingStarted) {
                    provingStarted = true;
                    startElapsedTimer(Date.now());
                  }
                  setStage(workerStage);
                },
              },
            ),
          { signal, timeoutMs: DEFAULT_PROOF_TIMEOUT_MS },
        );
        if (signal.aborted) return;

        setProof(result);
        setStage("generated");
        addEvent("generated");
        toast.success(`Proof generated for ${cred.title}`);
      } catch (e) {
        if (signal.aborted) return;
        // ProofTimeoutError gets a distinct user-visible message — half the
        // point is that stalled provers fail visibly, not as a generic error.
        if (e instanceof ProofTimeoutError) {
          setError({
            code: null,
            friendly:
              "Proof generation timed out. The prover took too long — this can happen on slow devices or with large circuits. Please try again.",
            raw: e.message,
          });
          setErrorPhase("timeout");
          setStage("error");
          toast.error("Proof timed out — please try again.");
          return;
        }
        const parsed = parseContractError((e as Error).message);
        setError(parsed);
        setErrorPhase("proving");
        setStage("error");
        toast.error(`Proof generation failed: ${parsed.friendly}`);
      } finally {
        // Always clean up: the timer. The abort controller stays referenced by
        // cancel() until the next run replaces it.
        stopElapsedTimer();
      }
    })();

    return () => {
      // Unmounting (or switching credential) cancels the in-flight job in the
      // worker, not just this component's view of it.
      controller.abort();
      abortRef.current = null;
      stopElapsedTimer();
    };
  }, [cred]); // eslint-disable-line react-hooks/exhaustive-deps -- cred is the sole trigger; addEvent/toast are stable refs

  // ── Preflight simulation ─────────────────────────────────────────────────
  // Runs a Soroban preflight so a doomed submission is caught before the
  // wallet signature is requested. On success, surfaces the fee estimate.

  const onPreflight = useCallback(
    async (holder: string) => {
      if (!proof || !cred) return;
      setError(null);
      setErrorPhase(null);
      setFee(null);
      setStage("preflight");
      addEvent("preflight");
      try {
        const preflight = await preflightSubmitProof({
          holder,
          issuerId: cred.issuerId,
          credentialType: cred.type,
          proof: proof.proof,
          publicInputs: proof.publicInputs,
          ttlSecs: credTtlSecs(cred),
        });
        if (!preflight.ok) {
          setError(preflight.error);
          setErrorPhase("preflight");
          setStage("error");
          toast.error(`Submission blocked — ${preflight.error.friendly}`);
          return;
        }
        setFee(preflight.fee);
        setStage("readyToSign");
      } catch (e) {
        const parsed = parseContractError((e as Error).message);
        setError(parsed);
        setErrorPhase("preflight");
        setStage("error");
        toast.error(`Preflight simulation failed: ${parsed.friendly}`);
      }
    },
    [proof, cred, addEvent, toast],
  );

  // ── Sign and submit ─────────────────────────────────────────────────────
  // Only reached after the preflight simulation succeeded (or user override).

  const doSignAndSubmit = useCallback(
    async (holder: string, networkMismatch: boolean) => {
      if (!proof || !cred || networkMismatch) return;
      setStage("submitting");
      addEvent("submitted");
      toast.info(`Submitting proof for ${cred.title} to Stellar…`);
      try {
        const hash = await submitFn({
          holder,
          issuerId: cred.issuerId,
          credentialType: cred.type,
          proof: proof.proof,
          publicInputs: proof.publicInputs,
          ttlSecs: credTtlSecs(cred),
        });
        setTxHash(hash);
        setStage("confirmed");
        addEvent("verified", { txHash: hash });
        toast.success(`Proof confirmed on-chain for ${cred.title}`, { txHash: hash });
        return hash;
      } catch (e) {
        const parsed = parseContractError((e as Error).message);
        setError(parsed);
        setErrorPhase("submitting");
        setStage("error");
        toast.error(`Submission failed: ${parsed.friendly}`);
        return null;
      }
    },
    [proof, cred, submitFn, addEvent, toast],
  );

  // ── Combined: preflight → sign ───────────────────────────────────────────
  // Convenience for the "Submit to Stellar" button (before preflight is run).

  const onSubmit = useCallback(
    async (holder: string, _networkMismatch: boolean) => {
      await onPreflight(holder);
    },
    [onPreflight],
  );

  // Retry submission without re-proving when the proof already exists.

  const onRetrySubmit = useCallback(
    async (holder: string, networkMismatch: boolean) => {
      setError(null);
      setErrorPhase(null);
      if (fee) {
        // Already passed preflight; skip straight to signing.
        return doSignAndSubmit(holder, networkMismatch);
      }
      // No fee cached; run preflight then sign.
      await onPreflight(holder);
    },
    [fee, doSignAndSubmit, onPreflight],
  );

  const reset = useCallback(() => {
    setStage("idle");
    setProof(null);
    setTxHash("");
    setError(null);
    setErrorPhase(null);
    setFee(null);
    setElapsed(0);
  }, []);

  return {
    stage,
    proof,
    txHash,
    error,
    errorPhase,
    fee,
    elapsed,
    onSubmit,
    onPreflight,
    doSignAndSubmit,
    onRetrySubmit,
    cancel,
    reset,
  };
}
