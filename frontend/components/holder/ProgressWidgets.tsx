"use client";

import { useEffect, useState } from "react";
import { IconCheck, IconLoader2, IconAlertTriangle } from "@tabler/icons-react";

// ── ProofProgress ─────────────────────────────────────────────────────────────

type StepStatus = "pending" | "active" | "done" | "error";

type ProgressStep = {
  label: string;
  status: StepStatus;
  error?: string;
};

export function ProofProgress({ steps }: { steps: ProgressStep[] }) {
  return (
    <div role="list" aria-label="Proof progress" style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
      {steps.map((s, idx) => {
        const isLast = idx === steps.length - 1;
        return (
          <div
            key={s.label}
            role="listitem"
            aria-current={s.status === "active" ? "step" : undefined}
            style={{ display: "flex", gap: "0.85rem", alignItems: "flex-start" }}
          >
            <div
              aria-hidden="true"
              style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 28, flexShrink: 0 }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  border: `1px solid ${
                    s.status === "done" ? "var(--accent)" :
                    s.status === "active" ? "rgba(62,207,142,0.5)" :
                    "var(--border-strong)"
                  }`,
                  background: s.status === "done" ? "var(--accent)" : "transparent",
                  color: s.status === "done" ? "var(--bg)" : s.status === "active" ? "var(--accent)" : "var(--faint)",
                  transition: "all 0.25s var(--ease)",
                }}
              >
                {s.status === "done" ? (
                  <IconCheck size={13} stroke={3} aria-hidden="true" />
                ) : s.status === "active" ? (
                  <IconLoader2 size={13} className="spin" aria-hidden="true" />
                ) : s.status === "error" ? (
                  <IconAlertTriangle size={13} aria-hidden="true" />
                ) : (
                  <span style={{ fontSize: "0.7rem", color: "var(--faint)" }}>&bull;</span>
                )}
              </div>
              {!isLast && (
                <div
                  style={{
                    width: 1,
                    flex: 1,
                    minHeight: 20,
                    marginTop: 6,
                    background: s.status === "done" ? "var(--accent)" : "var(--border)",
                    opacity: s.status === "done" ? 0.4 : 1,
                    transition: "background 0.3s var(--ease)",
                  }}
                />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", paddingTop: "0.25rem" }}>
                <span style={{ fontWeight: 600, fontSize: "0.9rem", color: s.status === "pending" ? "var(--muted)" : "var(--text)" }}>
                  {s.label}
                </span>
                {s.status !== "active" && <span className="sr-only">({s.status})</span>}
                {s.status === "active" && (
                  <span
                    style={{
                      fontSize: "0.68rem",
                      color: "var(--accent)",
                      background: "rgba(62,207,142,0.1)",
                      border: "1px solid rgba(62,207,142,0.2)",
                      borderRadius: 999,
                      padding: "0.12rem 0.45rem",
                      fontWeight: 500,
                    }}
                  >
                    running
                  </span>
                )}
              </div>
              {s.error && (
                <div role="alert" style={{ marginTop: "0.45rem", color: "var(--danger)", fontSize: "0.82rem" }}>
                  {s.error}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── ProvingBar ────────────────────────────────────────────────────────────────

export function ProvingBar({ progress = 0 }: { progress?: number }) {
  const value = Math.round(Math.min(100, Math.max(0, progress)));
  return (
    <div
      role="progressbar"
      aria-label="Proof generation progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      style={{
        height: "4px",
        borderRadius: "999px",
        background: "var(--bg-soft)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          background: "var(--accent)",
          width: `${progress}%`,
          transition: "width 1s linear",
        }}
      />
    </div>
  );
}

// ── AnimatedDots ──────────────────────────────────────────────────────────────

/** True when the user has asked the OS to minimise non-essential motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function AnimatedDots({ text, style }: { text: string; style?: React.CSSProperties }) {
  const [dots, setDots] = useState(".");
  useEffect(() => {
    // The CSS reduced-motion override can't reach a JS timer, so honour the
    // preference here too (WCAG 2.3.3) and show a static ellipsis instead.
    if (prefersReducedMotion()) {
      const id = setTimeout(() => setDots("..."), 0);
      return () => clearTimeout(id);
    }
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? "." : d + ".")), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ fontSize: "0.8rem", color: "var(--muted)", ...style }}>
      {text}
      {/* Decorative: the cycling dots would otherwise be re-read by screen readers. */}
      <span aria-hidden="true" style={{ color: "var(--accent)" }}>
        {dots}
      </span>
    </span>
  );
}

// ── toHex helper ──────────────────────────────────────────────────────────────

export function toHex(u8: Uint8Array): string {
  return Array.from(u8.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
