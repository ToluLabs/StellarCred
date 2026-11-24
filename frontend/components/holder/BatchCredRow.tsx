"use client";

import { IconCpu, IconAlertTriangle } from "@tabler/icons-react";
import { truncateHash } from "@/lib/format";
import type { Credential } from "@/lib/credential";
import type { CredProofState } from "@/lib/hooks/useBatchProofFlow";
import { ProofStep } from "./ProofStep";
import { AnimatedDots, ProvingBar, toHex } from "./ProgressWidgets";

const ESTIMATES = { expected: 15, max: 20 };

export function BatchCredRow({
  cred,
  state,
  isLast,
}: {
  cred: Credential;
  state: CredProofState;
  isLast: boolean;
}) {
  const isPending = state.status === "pending";
  const isWitness = state.status === "witness";
  const isProving = state.status === "proving";
  const isReady = state.status === "ready";
  const isErr = state.status === "error";

  const stepState: "idle" | "active" | "done" =
    isReady ? "done" :
    isProving || isWitness ? "active" :
    "idle";

  const detail = isWitness ? (
    <AnimatedDots text="Computing witness" style={{ marginTop: "0.25rem" }} />
  ) : isProving ? (
    <div style={{ marginTop: "0.35rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
      <ProvingBar progress={Math.min(((state.elapsed) / ESTIMATES.expected) * 80, 80)} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
          {state.elapsed > ESTIMATES.max * 1.5 ? "Taking a bit longer than usual..." : "Generating proof in browser..."}
        </span>
        <span className="mono" style={{ fontSize: "0.7rem", color: "var(--faint)" }}>
          {state.elapsed}s
        </span>
      </div>
    </div>
  ) : isReady ? (
    <div style={{ marginTop: "0.2rem" }}>
      <span className="mono" style={{ fontSize: "0.72rem", color: "var(--accent)" }}>
        &pi; {truncateHash("0x" + toHex(state.proof.proof))}
      </span>
      <span className="mono faint" style={{ fontSize: "0.7rem", marginLeft: "0.4rem" }}>
        {state.proof.proof.length.toLocaleString()} bytes
      </span>
    </div>
  ) : isErr ? (
    <span style={{ fontSize: "0.72rem", color: "var(--danger)", marginTop: "0.2rem", display: "block" }}>
      {state.message.slice(0, 80)}
    </span>
  ) : null;

  const icon =
    isPending ? <span style={{ fontSize: "0.65rem", color: "var(--faint)" }}>{cred.type.slice(0, 3)}</span> :
    isErr ? <IconAlertTriangle size={13} /> :
    <IconCpu size={13} stroke={1.8} />;

  return (
    <ProofStep
      icon={icon}
      title={cred.title}
      subtitle={cred.claim}
      state={stepState}
      detail={detail}
      last={isLast}
    />
  );
}
