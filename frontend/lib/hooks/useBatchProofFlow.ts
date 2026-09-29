"use client";

/**
 * useBatchProofFlow — manages the state machine for batch proof generation
 * and submission of multiple credentials in a single on-chain transaction.
 *
 * Proofs are generated sequentially (one credential at a time) inside the
 * dedicated prover worker (lib/proof-client.ts), then all are submitted
 * atomically via ProofRegistry.submit_proofs. Each credential's proving runs
 * off the main thread, so the per-credential rows keep animating while
 * proving happens on the worker.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Credential } from "../credential";
import { proofSubmissionConfigured } from "../config";
import { proveOffMainThread } from "../proof-client";
import {
  submitProofs,
  preflightSubmitProofs,
  parseContractError,
  type ContractError,
  type FeeEstimate,
  type ProofSubmissionParams,
} from "../contracts";
import { credTtlSecs } from "../proof-helpers";
import { addTimelineEvent } from "../useProofTimeline";
import { probeRpcHealth, type RpcIssue } from "../rpc-health";
import { useToast } from "@/components/Toast";

export type CredProofState =
  | { status: "pending" }
  | { status: "witness" }
  | { status: "proving"; elapsed: number }
  | { status: "ready"; proof: { proof: Uint8Array; publicInputs: Uint8Array } }
  | { status: "error"; message: string };

export type BatchStage =
  | "generating"
  /** Degraded mode: the RPC is unreachable, so proving was deferred (#634). */
  | "blocked"
  | "submitting"
  | "confirmed"
  | "error";

export function useBatchProofFlow(
  creds: Credential[],
  holder: string,
  networkMismatch: boolean,
  onProved: (txHash: string, commitments: string[]) => void,
) {
  const [credStates, setCredStates] = useState<CredProofState[]>(
    () => creds.map(() => ({ status: "pending" as const })),
  );
  const [batchStage, setBatchStage] = useState<BatchStage>("generating");
  const [txHash, setTxHash] = useState("");
  const [batchError, setBatchError] = useState<ContractError | null>(null);
  /** Estimated fee reported by the batch preflight simulation. */
  const [batchFee, setBatchFee] = useState<FeeEstimate | null>(null);
  const toast = useToast();
  const generatedProofs = useRef<Array<{ proof: Uint8Array; publicInputs: Uint8Array } | null>>(
    creds.map(() => null),
  );
  const credsRef = useRef(creds);
  const holderRef = useRef(holder);
  const onProvedRef = useRef(onProved);
  /** The in-flight batch's controller — aborting it cancels the worker's job. */
  const abortRef = useRef<AbortController | null>(null);
  /** Set while the batch is deferred because the RPC endpoint is down. */
  const [rpcIssue, setRpcIssue] = useState<RpcIssue | null>(null);
  useEffect(() => { credsRef.current = creds; }, [creds]);
  useEffect(() => { holderRef.current = holder; }, [holder]);
  useEffect(() => { onProvedRef.current = onProved; }, [onProved]);

  // User-initiated cancel: aborts whatever proof is in flight inside the
  // worker, not just this component's view of the batch.
  const cancel = () => {
    abortRef.current?.abort();
  };

  // ── Sequential proof generation ────────────────────────────────────────────
  // Each credential is proved in sequence to avoid overloading the worker;
  // every heavy step happens inside it.
  const runGeneration = useCallback(
    (controller: AbortController) => {
    const { signal } = controller;
    // Read the batch from the ref so a parent re-render that rebuilds the
    // `creds` array cannot restart (and abort) a batch already in flight.
    const batch = credsRef.current;
    toast.info(`Generating ${batch.length} proofs…`);

    (async () => {
      for (let i = 0; i < batch.length; i++) {
        if (signal.aborted) return;
        const cred = batch[i];

        setCredStates((prev) => {
          const next = [...prev];
          next[i] = { status: "witness" };
          return next;
        });

        // Elapsed timer for this credential, started when the worker reports
        // its first proving stage and always cleared before moving on.
        const start = Date.now();
        let timer: ReturnType<typeof setInterval> | null = null;
        const tick = () =>
          setCredStates((prev) => {
            const next = [...prev];
            if (next[i].status === "proving") {
              next[i] = { status: "proving", elapsed: Math.floor((Date.now() - start) / 1000) };
            }
            return next;
          });

        let result: { proof: Uint8Array; publicInputs: Uint8Array };
        try {
          result = await proveOffMainThread(
            {
              credentialType: cred.type,
              credential: cred as unknown as Record<string, unknown>,
            },
            {
              signal,
              onProgress: (stage) => {
                if (signal.aborted || stage === "witness" || timer) return;
                timer = setInterval(tick, 1000);
                setCredStates((prev) => {
                  const next = [...prev];
                  next[i] = { status: "proving", elapsed: 0 };
                  return next;
                });
              },
            },
          );
        } catch (e) {
          if (timer) clearInterval(timer);
          if (signal.aborted) return;
          setCredStates((prev) => {
            const next = [...prev];
            next[i] = { status: "error", message: (e as Error).message };
            return next;
          });
          setBatchStage("error");
          const parsed = parseContractError((e as Error).message);
          setBatchError(parsed);
          toast.error(`Proof generation failed for ${cred.title}: ${parsed.friendly}`);
          return;
        }

        if (timer) clearInterval(timer);
        if (signal.aborted) return;

        generatedProofs.current[i] = result;
        setCredStates((prev) => {
          const next = [...prev];
          next[i] = { status: "ready", proof: result };
          return next;
        });
        addTimelineEvent(cred.commitment, "generated");
      }
    })();
    },
    [toast],
  );

  // Runs once on mount — but only after the network answers. A batch spends
  // N × ~15 s of proving; doing that during an outage just to fail at
  // preflight is the expensive mistake #634 asks us to avoid.
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    void (async () => {
      const issue = await probeRpcHealth();
      if (signal.aborted) return;
      if (issue) {
        setRpcIssue(issue);
        setBatchError({
          code: null,
          friendly: `${issue.message} Proof generation was deferred: the batch would only fail at submission.`,
          raw: issue.message,
        });
        setBatchStage("blocked");
        return;
      }
      setBatchStage("generating");
      runGeneration(controller);
    })();

    return () => {
      // Cancels whatever proof is in flight inside the worker, not just this
      // component's view of the batch.
      controller.abort();
      abortRef.current = null;
    };
  }, [runGeneration, toast]);

  /** Prove the batch anyway, without re-checking the network. */
  const proceedAnyway = useCallback(() => {
    const controller = abortRef.current ?? new AbortController();
    abortRef.current = controller;
    setRpcIssue(null);
    setBatchError(null);
    setBatchStage("generating");
    runGeneration(controller);
  }, [runGeneration]);

  /** Re-check the network from the blocked state and prove if it recovered. */
  const retryNetworkCheck = useCallback(async () => {
    const issue = await probeRpcHealth();
    if (issue) {
      setRpcIssue(issue);
      return;
    }
    proceedAnyway();
  }, [proceedAnyway]);

  // ── Auto-submit when all proofs are ready ──────────────────────────────────
  // Fires once when every credential has status "ready" and the wallet is on
  // the correct network. Includes a preflight simulation before submission.
  const allReady =
    batchStage === "generating" &&
    credStates.length > 0 &&
    credStates.every((s) => s.status === "ready");
  const blockedByNetwork = allReady && networkMismatch;

  useEffect(() => {
    if (!allReady || networkMismatch) return;
    if (!proofSubmissionConfigured()) return;

    const currentCreds = credsRef.current;
    const currentHolder = holderRef.current;

    toast.success(`Generated ${currentCreds.length} proofs`);
    setBatchStage("submitting");

    const submissions: ProofSubmissionParams[] = currentCreds.map((cred, i) => {
      const p = generatedProofs.current[i]!;
      return {
        issuerId: cred.issuerId,
        credentialType: cred.type,
        proof: p.proof,
        publicInputs: p.publicInputs,
        ttlSecs: credTtlSecs(cred),
      };
    });

    currentCreds.forEach((cred) => addTimelineEvent(cred.commitment, "submitted"));

    // Stage 1 — preflight simulation: catch a doomed batch before a wallet
    // signature is spent.
    setBatchFee(null);
    toast.info(`Simulating batch of ${currentCreds.length} proofs…`);
    (async () => {
      const preflight = await preflightSubmitProofs({ holder: currentHolder, submissions });
      if (!preflight.ok) {
        setBatchError(preflight.error);
        setBatchStage("error");
        toast.error(`Batch submission blocked — ${preflight.error.friendly}`);
        return;
      }
      setBatchFee(preflight.fee);

      // Stage 2 — simulation succeeded, sign and submit.
      try {
        const hash = await submitProofs({ holder: currentHolder, submissions });
        setTxHash(hash);
        const commitments = currentCreds.map((c) => c.commitment);
        onProvedRef.current(hash, commitments);
        setBatchStage("confirmed");
        currentCreds.forEach((cred) => addTimelineEvent(cred.commitment, "verified", { txHash: hash }));
        toast.success(`Confirmed ${currentCreds.length} proofs on-chain`, { txHash: hash });
      } catch (e) {
        const parsed = parseContractError((e as Error).message);
        setBatchError(parsed);
        setBatchStage("error");
        toast.error(`Batch submission failed: ${parsed.friendly}`);
      }
    })();
  }, [allReady, networkMismatch, toast]); // eslint-disable-line react-hooks/exhaustive-deps -- allReady is the trigger; refs avoid stale closures

  return {
    credStates,
    batchStage,
    txHash,
    batchError,
    batchFee,
    blockedByNetwork,
    /** Set while the batch is deferred because the RPC endpoint is down. */
    rpcIssue,
    proceedAnyway,
    retryNetworkCheck,
    cancel,
  };
}
