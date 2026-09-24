"use client";

import { useState, useEffect } from "react";
import { IconHistory, IconChevronDown, IconChevronRight, IconCopy, IconExternalLink, IconCheck } from "@tabler/icons-react";
import { getSubmissions, type SubmissionRecord } from "@/lib/history";
import { truncateHash } from "@/lib/format";
import { EXPLORER_TX } from "@/lib/stellar";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }} className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem", fontSize: "0.7rem" }} title="Copy transaction hash" type="button">
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

function StatusBadge({ status }: { status: SubmissionRecord["status"] }) {
  const c: Record<string, { bg: string; text: string; dot: string }> = {
    confirmed: { bg: "rgba(62,207,142,0.1)", text: "#3ecf8e", dot: "#3ecf8e" },
    pending: { bg: "rgba(245,158,11,0.1)", text: "#f59e0b", dot: "#f59e0b" },
    failed: { bg: "rgba(240,96,77,0.1)", text: "#f0604d", dot: "#f0604d" },
  };
  const s = c[status] || c.pending;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", padding: "0.2rem 0.6rem", borderRadius: "999px", fontSize: "0.7rem", fontWeight: 500, background: s.bg, color: s.text, border: `1px solid ${s.dot}20` }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: s.dot }} />{status}</span>;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function SubmissionHistory() {
  const [expanded, setExpanded] = useState(false);
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>([]);

  useEffect(() => { setSubmissions(getSubmissions()); }, []);
  const refresh = () => setSubmissions(getSubmissions());

  if (submissions.length === 0) return null;

  return (
    <div style={{ marginTop: "2rem" }}>
      <button onClick={() => { setExpanded(!expanded); if (!expanded) refresh(); }} className="row" style={{ gap: "0.5rem", background: "none", border: "none", cursor: "pointer", padding: "0.5rem 0", color: "var(--muted)", fontSize: "0.875rem", fontWeight: 500 }} type="button">
        <IconHistory size={16} stroke={1.5} />Submission history ({submissions.length}){expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
      </button>
      {expanded && (
        <div style={{ marginTop: "0.75rem" }}>
          {submissions.map((s, i) => (
            <div key={`${s.txHash}-${i}`} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 1rem", borderBottom: i < submissions.length - 1 ? "1px solid var(--border)" : "none", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "0.85rem", textTransform: "capitalize" }}>{s.credentialType}</div>
                <div className="row" style={{ gap: "0.5rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontSize: "0.72rem", color: "var(--muted)" }}>{truncateHash(s.txHash)}</span>
                  <CopyButton text={s.txHash} />
                  <a href={EXPLORER_TX(s.txHash)} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: "0.15rem", fontSize: "0.72rem", color: "var(--accent)" }}>Explorer<IconExternalLink size={10} /></a>
                </div>
              </div>
              <div className="row" style={{ gap: "0.5rem", alignItems: "center", flexShrink: 0 }}>
                <StatusBadge status={s.status} />
                <span style={{ fontSize: "0.72rem", color: "var(--faint)" }}>{formatTimestamp(s.timestamp)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

