"use client";

// Debug view for proving-performance telemetry (GitHub #432).
//
// Shows the measured time-to-first-proof and per-stage timings (witness,
// prove, submit) captured by lib/proof-telemetry, marks any run that exceeded
// its budget, offers the anonymized opt-in report, and lets the user clear the
// local history. Loaded lazily from the holder page via next/dynamic so its
// weight stays out of the holder route's initial bundle.

import { useCallback, useEffect, useState } from "react";
import {
  IconAlertTriangle,
  IconChartBar,
  IconCloudUpload,
  IconCpu,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import {
  getProofRuns,
  clearProofRuns,
  isTelemetryOptIn,
  setTelemetryOptIn,
  reportOptedInRuns,
  summarizeProofs,
  PROOF_PERF_TARGETS,
  type ProofRun,
  type StageTiming,
} from "@/lib/proof-telemetry";

function stageIcon(stage: string) {
  if (stage === "witness") return <IconCpu size={12} />;
  if (stage === "submit") return <IconCloudUpload size={12} />;
  return <IconChartBar size={12} />;
}

function fmt(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function ProofPerfPanel() {
  const [runs, setRuns] = useState<ProofRun[]>(() => getProofRuns());
  const [optedIn, setOptedIn] = useState(() => isTelemetryOptIn());
  const [reported, setReported] = useState("");

  const reload = useCallback(() => setRuns(getProofRuns()), []);
  useEffect(() => reload(), [reload]);

  const summary = summarizeProofs(runs);

  async function onReport() {
    if (!optedIn) return;
    const sent = await reportOptedInRuns();
    reload();
    setReported(
      sent > 0 ? `Reported ${sent} anonymized run${sent > 1 ? "s" : ""}` : "Nothing new to report",
    );
    setTimeout(() => setReported(""), 4000);
  }

  function onToggleOptIn(next: boolean) {
    setTelemetryOptIn(next);
    setOptedIn(next);
  }

  return (
    <div className="card reveal" style={{ padding: "1.25rem 1.5rem" }}>
      <div className="between" style={{ gap: "0.75rem", flexWrap: "wrap" }}>
        <span className="eyebrow" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <IconChartBar size={14} />
          Proof performance
        </span>
        <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
          <label className="row faint" style={{ gap: "0.4rem", fontSize: "0.75rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={optedIn}
              onChange={(e) => onToggleOptIn(e.target.checked)}
            />
            Share anonymized timing data
          </label>
          <button className="btn btn-ghost btn-sm" onClick={onReport} disabled={!optedIn}>
            <IconUpload size={12} />
            Report
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClear}>
            <IconTrash size={12} />
            Clear
          </button>
        </div>
      </div>

      {reported && (
        <p style={{ fontSize: "0.72rem", color: "var(--accent)", margin: "0.3rem 0 0" }}>
          {reported}
        </p>
      )}

      <div className="faint" style={{ fontSize: "0.72rem", margin: "0.4rem 0 0.75rem", lineHeight: 1.6 }}>
        Timings are measured locally and kept only in this browser. Nothing is sent
        unless you opt in above. Time-to-first-proof target:{" "}
        <span className="mono">{fmt(PROOF_PERF_TARGETS.timeToFirstProofMs)}</span>.
      </div>

      {runs.length === 0 ? (
        <p style={{ fontSize: "0.8rem", color: "var(--faint)", margin: "0.25rem 0" }}>
          No proofs measured yet — generate a proof and its timings will appear here.
        </p>
      ) : (
        <>
          {/* Aggregate summary */}
          <div
            className="row"
            style={{ gap: "0.6rem", flexWrap: "wrap", marginBottom: "0.85rem" }}
          >
            <Metric label="Runs" value={String(summary.totalRuns)} />
            <Metric
              label="Avg TTFP"
              value={fmt(summary.timeToFirstProof.avgMs)}
              warn={
                summary.totalRuns > 0 &&
                summary.timeToFirstProof.avgMs > PROOF_PERF_TARGETS.timeToFirstProofMs
              }
            />
            <Metric label="p50 TTFP" value={fmt(summary.timeToFirstProof.p50Ms)} />
            <Metric
              label="Over budget"
              value={String(summary.byStage.reduce((a, s) => a + s.overCount, 0))}
              warn={summary.byStage.some((s) => s.overCount > 0)}
            />
          </div>

          {/* Run list */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {runs.slice(0, 10).map((r) => (
              <ProofRunRow key={r.id} run={r} />
            ))}
          </div>
        </>
      )}
    </div>
  );

  function onClear() {
    clearProofRuns();
    reload();
  }
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div
      style={{
        padding: "0.4rem 0.75rem",
        borderRadius: "var(--radius)",
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${warn ? "rgba(240,96,77,0.4)" : "var(--border)"}`,
      }}
    >
      <div className="faint" style={{ fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: "0.85rem", fontWeight: 600, color: warn ? "var(--danger)" : "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}

function ProofRunRow({ run }: { run: ProofRun }) {
  const over = run.exceededBudget || run.status === "errored";
  const failed = run.status === "errored";
  return (
    <div
      style={{
        padding: "0.6rem 0.75rem",
        borderRadius: "var(--radius)",
        border: `1px solid ${
          failed ? "rgba(240,96,77,0.4)" : over ? "rgba(234,179,8,0.35)" : "var(--border)"
        }`,
        background: over ? "rgba(255,255,255,0.02)" : "transparent",
      }}
    >
      <div className="between" style={{ gap: "0.5rem" }}>
        <span className="row" style={{ gap: "0.45rem", fontSize: "0.8rem", minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{run.credentialType || "proof"}</span>
          {run.warm && (
            <span
              style={{
                fontSize: "0.62rem",
                color: "var(--accent)",
                background: "rgba(62,207,142,0.1)",
                border: "1px solid rgba(62,207,142,0.25)",
                borderRadius: 999,
                padding: "0.05rem 0.4rem",
              }}
            >
              warm
            </span>
          )}
          <span className="faint" style={{ fontSize: "0.68rem" }}>
            {run.deviceClass} · {run.cores}c{run.memoryGB ? ` · ${run.memoryGB}GB` : ""}
          </span>
        </span>
        <span className="mono" style={{ fontSize: "0.72rem", color: over ? "var(--warn)" : "var(--faint)" }}>
          TTFP {fmt(run.timeToFirstProofMs)}
          {run.totalMs !== run.timeToFirstProofMs ? ` · total ${fmt(run.totalMs)}` : ""}
        </span>
      </div>

      <div className="row" style={{ gap: "0.75rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
        {run.stages.map((s) => (
          <StageBadge key={s.stage} s={s} />
        ))}
      </div>

      {(over || failed) && (
        <div className="row faint" style={{ gap: "0.35rem", marginTop: "0.4rem", fontSize: "0.7rem" }}>
          <IconAlertTriangle size={12} style={{ color: failed ? "var(--danger)" : "var(--warn)" }} />
          <span>
            {failed
              ? `Failed during ${run.errorStage ?? "proof"}${run.errorStage === "prove" ? " — try a warm run next time" : ""}.`
              : "Over the target budget — this run exceeded a stage or the total window."}
          </span>
        </div>
      )}
    </div>
  );
}

function StageBadge({ s }: { s: StageTiming }) {
  return (
    <span
      className="row mono"
      title={`budget ${fmt(s.budgetMs)}`}
      style={{
        gap: "0.35rem",
        fontSize: "0.7rem",
        color: s.overBudget ? "var(--danger)" : "var(--muted)",
      }}
    >
      {stageIcon(s.stage)}
      {s.stage}: {fmt(s.durationMs)}
      {s.overBudget && <IconAlertTriangle size={11} style={{ color: "var(--danger)" }} />}
    </span>
  );
}