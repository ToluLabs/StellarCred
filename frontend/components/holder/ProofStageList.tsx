"use client";

// Structured proving-stage list (GitHub #546).
//
// Replaces the generic spinner with a discrete per-stage step list driven by
// the worker's `progress` and `stageProgress` messages. Each stage shows:
//   • its current state (pending / running / done)
//   • a real elapsed-time counter (in seconds) while it's running
//   • an expected-duration hint derived from the PROOF_PERF_TARGETS baselines
//
// The list is purely presentational — all state comes from the parent via
// props, so it can be tested without any React context or effects.

import React from "react";
import { IconCheck, IconLoader2 } from "@tabler/icons-react";
import type { Stage } from "@/lib/hooks/useProofFlow";
import type { ProofStageProgress } from "@/lib/proof-client";

interface ProofStageItem {
  key: Stage;
  label: string;
  hint: string;
}

/** The three discrete proving stages, in the order they run. */
const PROOF_STAGES: ProofStageItem[] = [
  {
    key: "witness",
    label: "Generating witness",
    hint: "expected ~2–20 s",
  },
  {
    key: "circuit",
    label: "Loading circuit WASM",
    hint: "expected ~3–8 s",
  },
  {
    key: "proof",
    label: "Generating UltraPlonk proof",
    hint: "expected ~10–60 s",
  },
];

const STAGE_ORDER: Stage[] = ["witness", "circuit", "proof"];

function stageIndex(s: Stage): number {
  return STAGE_ORDER.indexOf(s);
}

function ElapsedBar({ elapsedMs, expectedMs }: { elapsedMs: number; expectedMs: number }) {
  const pct = expectedMs > 0 ? Math.min((elapsedMs / expectedMs) * 100, 99) : 0;
  return (
    <div
      aria-hidden="true"
      style={{
        height: 3,
        borderRadius: 999,
        background: "var(--bg-soft, rgba(255,255,255,0.07))",
        overflow: "hidden",
        marginTop: "0.3rem",
        width: "100%",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background: "var(--accent, #3ecf8e)",
          transition: "width 0.5s linear",
        }}
      />
    </div>
  );
}

export function ProofStageList({
  stage,
  stageProgress,
}: {
  stage: Stage;
  stageProgress: ProofStageProgress | null;
}) {
  const currentIdx = stageIndex(stage);

  return (
    <div
      role="list"
      aria-label="Proving stages"
      style={{ display: "flex", flexDirection: "column", gap: "0.55rem" }}
    >
      {PROOF_STAGES.map(({ key, label, hint }, i) => {
        const isRunning = stage === key;
        const isDone = currentIdx > i;
        const isPending = !isRunning && !isDone;

        const showProgress = isRunning && stageProgress && stageProgress.stage === key;
        const elapsedMs = showProgress ? stageProgress.elapsedMs : 0;
        const expectedMs = showProgress ? stageProgress.expectedMs : 0;
        const elapsedSecs = Math.floor(elapsedMs / 1000);

        return (
          <div
            key={key}
            role="listitem"
            aria-current={isRunning ? "step" : undefined}
            style={{
              display: "flex",
              gap: "0.65rem",
              alignItems: "flex-start",
              opacity: isPending ? 0.45 : 1,
              transition: "opacity 0.2s ease",
            }}
          >
            {/* Status icon */}
            <div
              aria-hidden="true"
              style={{
                flexShrink: 0,
                width: 22,
                height: 22,
                borderRadius: "50%",
                display: "grid",
                placeItems: "center",
                marginTop: 1,
                border: `1px solid ${
                  isDone
                    ? "var(--accent, #3ecf8e)"
                    : isRunning
                      ? "rgba(62,207,142,0.5)"
                      : "var(--border-strong, rgba(255,255,255,0.15))"
                }`,
                background: isDone ? "var(--accent, #3ecf8e)" : "transparent",
                color: isDone
                  ? "var(--bg, #0d0d0d)"
                  : isRunning
                    ? "var(--accent, #3ecf8e)"
                    : "var(--faint, rgba(255,255,255,0.3))",
                transition: "all 0.25s ease",
              }}
            >
              {isDone && <IconCheck size={12} stroke={3} />}
              {isRunning && <IconLoader2 size={12} className="spin" />}
              {isPending && (
                <span style={{ fontSize: "0.6rem", lineHeight: 1 }}>&bull;</span>
              )}
            </div>

            {/* Label + timing */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.5rem",
                }}
              >
                <span
                  style={{
                    fontSize: "0.82rem",
                    fontWeight: isRunning ? 600 : 500,
                    color: isPending
                      ? "var(--muted, rgba(255,255,255,0.5))"
                      : "var(--text, #f0f0f0)",
                  }}
                >
                  {label}
                </span>

                <span
                  className="mono"
                  style={{
                    fontSize: "0.7rem",
                    color: isRunning
                      ? "var(--accent, #3ecf8e)"
                      : "var(--faint, rgba(255,255,255,0.3))",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                  aria-live={isRunning ? "polite" : undefined}
                  aria-atomic={isRunning ? "true" : undefined}
                >
                  {isRunning && elapsedMs > 0
                    ? `${elapsedSecs} s`
                    : isRunning
                      ? hint
                      : isDone
                        ? "done"
                        : hint}
                </span>
              </div>

              {/* Elapsed progress bar — only while this stage is running */}
              {isRunning && showProgress && (
                <ElapsedBar elapsedMs={elapsedMs} expectedMs={expectedMs} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
