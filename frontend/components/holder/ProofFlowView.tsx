"use client";

import { useEffect, useRef, useState } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconCpu,
  IconCloudUpload,
  IconAlertTriangle,
  IconLoader2,
} from "@tabler/icons-react";
import { NetworkMismatchBanner } from "@/components/NetworkMismatchBanner";
import CopyButton from "@/components/CopyButton";
import { Check } from "@/components/Check";
import { proofSubmissionConfigured } from "@/lib/config";
import { truncateHash } from "@/lib/format";
import { EXPLORER_TX } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet-context";
import { useToast } from "@/components/Toast";
import { useProofFlow, type SubmitFn } from "@/lib/hooks/useProofFlow";
import { credTtlSecs } from "@/lib/proof-helpers";
import type { Credential } from "@/lib/credential";
import { ProofStep } from "./ProofStep";
import { ProofProgress, ProvingBar, AnimatedDots, toHex } from "./ProgressWidgets";

const ESTIMATES: Record<string, { range: string; expected: number; max: number }> = {
  default: { range: "~10–20 seconds", expected: 15, max: 20 },
};

export function ProofFlowView({
  cred,
  holder,
  onBack,
  onProved,
  submitFn,
}: {
  cred: Credential;
  holder: string;
  onBack: () => void;
  onProved: (txHash: string) => void;
  /** Override for sponsored/gasless submission. Uses normal path when omitted. */
  submitFn?: SubmitFn;
}) {
  const { networkMismatch } = useWallet();
  const toast = useToast();
  const [showRaw, setShowRaw] = useState(false);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const { stage, proof, txHash, error, errorPhase, fee, elapsed, onSubmit, doSignAndSubmit, onRetrySubmit, cancel } = useProofFlow(cred, submitFn);

  // User-initiated cancel: aborts the proof inside the prover worker and
  // returns to the list.
  const handleCancel = () => {
    cancel();
    toast.info("Proof generation cancelled");
    onBack();
  };

  // Focus management
  useEffect(() => {
    switch (stage) {
      case "generated":
        submitButtonRef.current?.focus();
        break;
      case "confirmed":
        successRef.current?.focus();
        break;
      case "error":
        errorRef.current?.focus();
        break;
    }
  }, [stage]);

  const handleSubmit = async () => {
    // First click: run preflight simulation
    await onSubmit(holder, networkMismatch);
  };

  const handleSignAndSubmit = async () => {
    // Second click after preflight passed: sign and submit
    const hash = await doSignAndSubmit(holder, networkMismatch);
    if (hash) onProved(hash);
  };

  const handleRetrySubmit = async () => {
    const hash = await onRetrySubmit(holder, networkMismatch);
    if (hash) onProved(hash);
  };

  const isGenerating = stage === "witness" || stage === "circuit" || stage === "proof";
  const proofDone = stage === "generated" || stage === "preflight" || stage === "readyToSign" || stage === "submitting" || stage === "confirmed";
  const submitDone = stage === "confirmed";

  return (
    <div className="reveal" style={{ maxWidth: 520, margin: "0 auto" }}>
      <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: "1.5rem" }}>
        <IconArrowLeft size={14} />
        All credentials
      </button>

      <div className="card" style={{ padding: "1.75rem" }}>
        {/* credential header */}
        <div style={{ marginBottom: "1.5rem" }}>
          <span className="eyebrow" style={{ marginBottom: "0.5rem", display: "block" }}>
            Proving
          </span>
          <h2 style={{ marginBottom: "0.25rem" }}>{cred.title}</h2>
          <span className="mono faint" style={{ fontSize: "0.8rem" }}>{cred.claim}</span>
        </div>

        {/* step list */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
          <ProofStep
            icon={<IconCpu size={14} stroke={1.8} />}
            title="Generate zero-knowledge proof"
            subtitle={`Estimated time: ${ESTIMATES.default.range}`}
            state={
              isGenerating ? "active" :
              proofDone ? "done" : "idle"
            }
            detail={
              isGenerating ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.65rem" }}>
                  <ProvingBar progress={Math.min((elapsed / ESTIMATES.default.expected) * 80, 80)} />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                      {elapsed > ESTIMATES.default.max * 1.5 ? "Taking a bit longer than usual…" :
                       stage === "witness" ? "Generating witness…" :
                       elapsed < 2 ? "Loading circuit…" : "Proving…"}
                    </span>
                    <span className="mono" style={{ fontSize: "0.72rem", color: "var(--faint)" }}>
                      {elapsed} s elapsed
                    </span>
                  </div>
                  <div style={{ margin: "0.5rem 0" }}>
                    <ProofProgress steps={[
                      {
                        label: "Load circuit WASM",
                        status: stage === "circuit" ? "active" : (stage === "proof" || proofDone) ? "done" : "pending",
                      },
                      {
                        label: "Generate ultraplonk proof",
                        status: stage === "proof" ? "active" : proofDone ? "done" : "pending",
                      },
                    ]} />
                  </div>
                  <span style={{ fontSize: "0.72rem", color: "var(--faint)" }}>
                    First run loads the WASM prover (~5–15 s). Proving runs off
                    the main thread, so this page stays responsive.
                  </span>
                  <div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={handleCancel}
                      style={{ fontSize: "0.75rem" }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : proofDone && proof ? (
                <div style={{ marginTop: "0.4rem" }}>
                  <span className="mono" style={{ fontSize: "0.75rem", color: "var(--accent)" }}>
                    π {truncateHash("0x" + toHex(proof.proof))}
                  </span>
                  <span className="mono faint" style={{ fontSize: "0.72rem", marginLeft: "0.5rem" }}>
                    {proof.proof.length.toLocaleString()} bytes
                  </span>
                </div>
              ) : null
            }
          />

          <ProofStep
            icon={<IconCloudUpload size={14} stroke={1.8} />}
            title="Submit to Stellar"
            subtitle="ProofRegistry.submit_proof · wallet signature"
            state={
              stage === "preflight" || stage === "readyToSign" || stage === "submitting"
                ? "active"
                : submitDone ? "done" : "idle"
            }
            last
            detail={
              stage === "preflight" ? (
                <AnimatedDots text="Running preflight simulation" style={{ marginTop: "0.35rem" }} />
              ) : stage === "readyToSign" ? (
                <div className="row" style={{ gap: "0.5rem", marginTop: "0.35rem", alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "0.75rem", color: "var(--accent)", fontWeight: 500 }}>
                    Estimated fee: {fee?.display ?? "—"}
                  </span>
                  <span className="faint" style={{ fontSize: "0.72rem" }}>
                    Simulation passed — ready to sign
                  </span>
                </div>
              ) : stage === "submitting" ? (
                <AnimatedDots text="Writing to ProofRegistry" style={{ marginTop: "0.35rem" }} />
              ) : submitDone ? (
                <div className="row" style={{ gap: "0.5rem", marginTop: "0.3rem", alignItems: "center" }}>
                  <a
                    href={EXPLORER_TX(txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="row accent"
                    style={{ gap: "0.3rem", fontSize: "0.775rem" }}
                  >
                    {txHash.slice(0, 8)}...{txHash.slice(-6)}
                    <IconExternalLink size={12} />
                  </a>
                  <CopyButton value={txHash} />
                </div>
              ) : null
            }
          />
        </div>

        {/* CTA */}
        {(stage === "generated" || stage === "preflight" || stage === "readyToSign") && (
          <>
            {networkMismatch && (
              <div style={{ marginTop: "1.5rem" }}>
                <NetworkMismatchBanner />
              </div>
            )}
            {stage === "preflight" ? (
              <button
                className="btn btn-primary"
                style={{ marginTop: networkMismatch ? 0 : "1.5rem", width: "100%", opacity: 0.7, cursor: "progress" }}
                disabled
              >
                <IconLoader2 size={15} className="spin" /> Running preflight simulation…
              </button>
            ) : stage === "readyToSign" ? (
              <button
                className="btn btn-primary"
                ref={submitButtonRef}
                style={{
                  marginTop: networkMismatch ? 0 : "1.5rem",
                  width: "100%",
                  opacity: networkMismatch ? 0.5 : 1,
                  cursor: networkMismatch ? "not-allowed" : "pointer",
                }}
                onClick={handleSignAndSubmit}
                disabled={networkMismatch || !proofSubmissionConfigured()}
                title={
                  networkMismatch
                    ? "Switch your wallet to the correct network to submit"
                    : !proofSubmissionConfigured()
                      ? "App not configured — NEXT_PUBLIC_PROOF_REGISTRY_ID missing"
                      : undefined
                }
              >
                Sign & submit{fee ? ` (${fee.display})` : ""}
                <IconArrowRight size={15} />
              </button>
            ) : (
              <button
                className="btn btn-primary"
                ref={submitButtonRef}
                style={{
                  marginTop: networkMismatch ? 0 : "1.5rem",
                  width: "100%",
                  opacity: networkMismatch ? 0.5 : 1,
                  cursor: networkMismatch ? "not-allowed" : "pointer",
                }}
                onClick={handleSubmit}
                disabled={networkMismatch || !proofSubmissionConfigured()}
                title={
                  networkMismatch
                    ? "Switch your wallet to the correct network to submit"
                    : !proofSubmissionConfigured()
                      ? "App not configured — NEXT_PUBLIC_PROOF_REGISTRY_ID missing"
                      : undefined
                }
              >
                Submit to Stellar
                <IconArrowRight size={15} />
              </button>
            )}
          </>
        )}

        {error && (
          <div
            ref={errorRef}
            tabIndex={-1}
            role="alert"
            style={{
              marginTop: "1.5rem",
              padding: "0.9rem 1.1rem",
              borderRadius: "var(--radius)",
              border: "1px solid rgba(240,96,77,0.3)",
              background: "rgba(240,96,77,0.06)",
            }}
          >
            <div className="row" style={{ gap: "0.5rem", color: "var(--danger)", fontWeight: 600, fontSize: "0.875rem" }}>
              <IconAlertTriangle size={15} />
              {errorPhase === "timeout"
                ? "Proof timed out"
                : errorPhase === "proving"
                  ? "Proof generation failed"
                  : errorPhase === "preflight"
                    ? "Submission blocked before signing"
                    : errorPhase === "submitting"
                      ? "Submission failed — proof is ready to retry"
                      : error.code !== null ? `Contract error #${error.code}` : "Could not complete"}
            </div>
            {error.raw !== error.friendly && (
              <div style={{ marginTop: "0.6rem" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowRaw((v) => !v)}
                  style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", color: "var(--faint)" }}
                >
                  {showRaw ? "Hide" : "Show"} raw error
                </button>
                {showRaw && (
                  <pre
                    className="mono"
                    style={{
                      marginTop: "0.5rem",
                      fontSize: "0.68rem",
                      color: "var(--faint)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      lineHeight: 1.5,
                      maxHeight: 180,
                      overflowY: "auto",
                      background: "rgba(0,0,0,0.2)",
                      padding: "0.6rem",
                      borderRadius: "calc(var(--radius) - 2px)",
                    }}
                  >
                    {error.raw}
                  </pre>
                )}
              </div>
            )}
            {/* Preflight failed — offer override to sign & submit anyway */}
            {errorPhase === "preflight" && proof && (
              <button
                className="btn btn-ghost"
                style={{ marginTop: "1rem", width: "100%" }}
                onClick={handleSignAndSubmit}
              >
                Sign & submit anyway
                <IconArrowRight size={15} />
              </button>
            )}
            {errorPhase === "submitting" && proof && (
              <button
                className="btn btn-primary"
                style={{ marginTop: "1rem", width: "100%" }}
                onClick={handleRetrySubmit}
              >
                Retry submission
                <IconArrowRight size={15} />
              </button>
            )}
          </div>
        )}

        {stage === "confirmed" && (
          <div
            ref={successRef}
            tabIndex={-1}
            role="status"
            aria-live="polite"
            className="reveal"
            style={{
              marginTop: "1.5rem",
              padding: "1.25rem",
              borderRadius: "var(--radius)",
              background: "rgba(62,207,142,0.07)",
              border: "1px solid rgba(62,207,142,0.2)",
              display: "flex",
              alignItems: "center",
              gap: "1rem",
            }}
          >
            <Check size={44} run />
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>Proof verified on-chain</div>
              <div className="muted" style={{ fontSize: "0.8375rem", marginTop: "0.25rem", lineHeight: 1.5 }}>
                Your claim is live on Stellar for {Math.round(credTtlSecs(cred) / 86_400)} days — without revealing the data behind it.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
