"use client";

import { useEffect, useRef, useState } from "react";
import {
  IconArrowLeft,
  IconExternalLink,
  IconCloudUpload,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { NetworkMismatchBanner } from "@/components/NetworkMismatchBanner";
import CopyButton from "@/components/CopyButton";
import { Check } from "@/components/Check";
import { EXPLORER_TX } from "@/lib/stellar";
import { useWallet } from "@/lib/wallet-context";
import { useToast } from "@/components/Toast";
import { useBatchProofFlow } from "@/lib/hooks/useBatchProofFlow";
import type { Credential } from "@/lib/credential";
import { ProofStep } from "./ProofStep";
import { AnimatedDots } from "./ProgressWidgets";
import { BatchCredRow } from "./BatchCredRow";

export function BatchProofFlowView({
  creds,
  holder,
  onBack,
  onProved,
}: {
  creds: Credential[];
  holder: string;
  onBack: () => void;
  onProved: (txHash: string, commitments: string[]) => void;
}) {
  const { networkMismatch } = useWallet();
  const toast = useToast();
  const [showRaw, setShowRaw] = useState(false);
  const networkMismatchRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const {
    credStates,
    batchStage,
    txHash,
    batchError,
    batchFee,
    blockedByNetwork,
    cancel,
  } = useBatchProofFlow(creds, holder, networkMismatch, onProved);

  const isSubmitting = batchStage === "submitting";
  const isConfirmed = batchStage === "confirmed";
  const isError = batchStage === "error";

  // Focus management
  useEffect(() => {
    if (blockedByNetwork) {
      networkMismatchRef.current?.focus();
      return;
    }
    switch (batchStage) {
      case "confirmed":
        successRef.current?.focus();
        break;
      case "error":
        errorRef.current?.focus();
        break;
    }
  }, [blockedByNetwork, batchStage]);

  return (
    <div className="reveal" style={{ maxWidth: 560, margin: "0 auto" }}>
      <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: "1.5rem" }}>
        <IconArrowLeft size={14} />
        All credentials
      </button>

      <div className="card" style={{ padding: "1.75rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <span className="eyebrow" style={{ marginBottom: "0.5rem", display: "block" }}>
            Batch proving
          </span>
          <h2 style={{ marginBottom: "0.25rem" }}>
            Prove all {creds.length} credentials
          </h2>
          <span className="faint" style={{ fontSize: "0.8rem" }}>
            Proofs are generated in your browser, then submitted in a single on-chain transaction.
          </span>
        </div>

        {/* Per-credential progress rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1.5rem" }}>
          {creds.map((cred, i) => {
            const cs = credStates[i] ?? { status: "pending" as const };
            return (
              <BatchCredRow
                key={cred.commitment}
                cred={cred}
                state={cs}
                isLast={i === creds.length - 1}
              />
            );
          })}
        </div>

        {/* Cancel while proofs are still being generated */}
        {batchStage === "generating" && (
          <div style={{ marginBottom: "1.25rem" }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                cancel();
                toast.info("Batch proof generation cancelled");
                onBack();
              }}
              style={{ fontSize: "0.75rem" }}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Submission step */}
        <ProofStep
          icon={<IconCloudUpload size={14} stroke={1.8} />}
          title="Submit batch to Stellar"
          subtitle={`ProofRegistry.submit_proofs · ${creds.length} credentials · single Freighter signature`}
          state={
            isSubmitting ? "active" :
            isConfirmed ? "done" : "idle"
          }
          last
          detail={
            isSubmitting ? (
              <div style={{ marginTop: "0.35rem" }}>
                <AnimatedDots
                  text={batchFee ? "Writing all proofs to ProofRegistry" : "Running preflight simulation"}
                />
                {batchFee && (
                  <span style={{ fontSize: "0.72rem", color: "var(--accent)", marginLeft: "0.5rem", fontWeight: 500 }}>
                    Estimate · {batchFee.display}
                  </span>
                )}
              </div>
            ) : isConfirmed ? (
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

        {/* Network mismatch */}
        {blockedByNetwork && (
          <div ref={networkMismatchRef} tabIndex={-1} role="status" style={{ marginTop: "1.5rem" }}>
            <NetworkMismatchBanner />
          </div>
        )}

        {/* Error banner */}
        {isError && batchError && (
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
              {batchError.code !== null ? `Contract error #${batchError.code}` : "Batch failed"}
            </div>
            <div style={{ fontSize: "0.8125rem", marginTop: "0.45rem", lineHeight: 1.65, color: "var(--text)" }}>
              {batchError.friendly}
            </div>
            {batchError.raw !== batchError.friendly && (
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
                    {batchError.raw}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        {/* Confirmed success banner */}
        {isConfirmed && (
          <div
            className="reveal"
            ref={successRef}
            tabIndex={-1}
            role="status"
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
              <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>
                All {creds.length} proofs verified on-chain
              </div>
              <div className="muted" style={{ fontSize: "0.8375rem", marginTop: "0.25rem", lineHeight: 1.5 }}>
                Every credential is now live on Stellar — submitted in a single transaction.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
