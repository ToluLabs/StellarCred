"use client";

import {
  IconCheck,
  IconLoader2,
} from "@tabler/icons-react";

type StepState = "idle" | "active" | "done";

export function ProofStep({
  icon,
  title,
  subtitle,
  state,
  detail,
  last = false,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  state: StepState;
  detail?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: "0.85rem", alignItems: "flex-start" }}>
      {/* left: connector */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 28, flexShrink: 0 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            border: `1px solid ${
              state === "done" ? "var(--accent)" :
              state === "active" ? "rgba(62,207,142,0.5)" :
              "var(--border-strong)"
            }`,
            background: state === "done" ? "var(--accent)" : "transparent",
            color: state === "done" ? "var(--bg)" : state === "active" ? "var(--accent)" : "var(--faint)",
            transition: "all 0.35s var(--ease)",
          }}
        >
          {state === "done" ? (
            <IconCheck size={13} stroke={3} />
          ) : state === "active" ? (
            <IconLoader2 size={13} className="spin" />
          ) : (
            icon
          )}
        </div>
        {!last && (
          <div
            style={{
              width: 1,
              flex: 1,
              minHeight: 20,
              marginTop: 4,
              background: state === "done" ? "var(--accent)" : "var(--border)",
              transition: "background 0.4s var(--ease)",
              opacity: state === "done" ? 0.4 : 1,
            }}
          />
        )}
      </div>

      {/* right: text */}
      <div style={{ paddingBottom: last ? 0 : "1.25rem", flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", paddingTop: "0.3rem" }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: "0.875rem",
              color: state === "idle" ? "var(--muted)" : "var(--text)",
              transition: "color 0.25s var(--ease)",
            }}
          >
            {title}
          </span>
          {state === "active" && (
            <span
              style={{
                fontSize: "0.68rem",
                color: "var(--accent)",
                background: "rgba(62,207,142,0.1)",
                border: "1px solid rgba(62,207,142,0.2)",
                borderRadius: "999px",
                padding: "0.1rem 0.45rem",
                fontWeight: 500,
              }}
            >
              running
            </span>
          )}
        </div>
        <div style={{ fontSize: "0.75rem", color: "var(--faint)", marginTop: "0.1rem" }}>
          {subtitle}
        </div>
        {detail}
      </div>
    </div>
  );
}
