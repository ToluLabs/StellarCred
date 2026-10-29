"use client";

import { useState } from "react";
import type { IssuanceQueueRecord } from "@/lib/issuance-queue";
import { issuanceQueueAction } from "../actions";

function fmt(ms?: number): string {
  return ms ? new Date(ms).toLocaleString() : "—";
}

function badge(r: IssuanceQueueRecord): string {
  return r.resolvedAt !== undefined ? "resolved" : r.status;
}

export function QueueTable({ initialRecords }: { initialRecords: IssuanceQueueRecord[] }) {
  const [records, setRecords] = useState(initialRecords);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, action: "retry" | "resolve") {
    const actor = window.prompt("Enter your admin ID:")?.trim();
    if (!actor) return;
    setBusy(id);
    setError(null);
    const res = await issuanceQueueAction(id, action, actor);
    setBusy(null);
    if (!res.success) {
      setError(res.error);
      return;
    }
    setRecords((prev) => prev.map((r) => (r.eventId === id ? res.record : r)));
  }

  if (records.length === 0) {
    return <p style={{ color: "var(--muted)" }}>No issuance records match.</p>;
  }

  return (
    <>
      {error && (
        <p role="alert" style={{ color: "var(--danger)" }}>
          Action failed: {error}
        </p>
      )}
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "8px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", color: "var(--text)" }}>
          <caption style={{ position: "absolute", clip: "rect(0 0 0 0)" }}>
            Pending and failed issuance records
          </caption>
          <thead>
            <tr>
              {["Event", "Provider", "Credential", "Status", "Error", "Retries", "Received", "Actions"].map(
                (c) => (
                  <th key={c} scope="col" style={{ padding: "0.75rem 1rem", textAlign: "left" }}>
                    {c}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {records.map((r) => {
              const done = r.resolvedAt !== undefined;
              return (
                <tr key={r.eventId} style={{ borderTop: "1px solid var(--border)" }}>
                  <th scope="row" style={{ padding: "0.75rem 1rem", fontFamily: "monospace" }}>
                    {r.eventId}
                  </th>
                  <td style={{ padding: "0.75rem 1rem" }}>{r.provider}</td>
                  <td style={{ padding: "0.75rem 1rem" }}>{r.credentialType}</td>
                  <td style={{ padding: "0.75rem 1rem" }}>{badge(r)}</td>
                  <td style={{ padding: "0.75rem 1rem" }}>{r.error ?? "—"}</td>
                  <td style={{ padding: "0.75rem 1rem" }}>
                    {r.retryCount}
                    {r.lastRetryAt ? ` (last ${fmt(r.lastRetryAt)})` : ""}
                  </td>
                  <td style={{ padding: "0.75rem 1rem", whiteSpace: "nowrap" }}>{fmt(r.timestamp)}</td>
                  <td style={{ padding: "0.75rem 1rem", whiteSpace: "nowrap" }}>
                    <button disabled={done || busy === r.eventId} onClick={() => act(r.eventId, "retry")}>
                      Retry
                    </button>{" "}
                    <button disabled={done || busy === r.eventId} onClick={() => act(r.eventId, "resolve")}>
                      Mark resolved
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
