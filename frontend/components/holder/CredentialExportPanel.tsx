"use client";

/**
 * CredentialExportPanel — Export credential history and review summary.
 *
 * Issue #909: Gives end users a way to export their credential history and
 * trust metadata in a portable JSON format, plus a visible review summary
 * inline on the holder page.
 *
 * The panel shows:
 *   - Aggregate counts (total, by type, by status)
 *   - Issuer list
 *   - Submission history timeline (from lib/history.ts)
 *   - Retention guidance (the export is safe to share — no private attributes)
 *   - A download button that produces the portable JSON document
 *
 * The export is deliberately non-secret: it contains commitment hashes,
 * issuer addresses, and proof status — never raw attribute values or
 * signatures. For a full encrypted backup, the existing "Export backup"
 * button (lib/backup.ts) handles that separately.
 */

import { useState, useEffect, useCallback } from "react";
import {
  IconDownload,
  IconHistory,
  IconShieldCheck,
  IconInfoCircle,
  IconClock,
  IconCheck,
  IconX,
} from "@tabler/icons-react";
import { loadCredentials, type Credential } from "@/lib/credential";
import { getSubmissions, type SubmissionRecord } from "@/lib/history";
import { proofStatus } from "@/lib/proof-helpers";
import { downloadCredentialExport } from "@/lib/credential-export";

function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function statusIcon(status: SubmissionRecord["status"]) {
  if (status === "confirmed")
    return <IconCheck size={12} style={{ color: "var(--accent)" }} aria-hidden="true" />;
  if (status === "failed")
    return <IconX size={12} style={{ color: "var(--danger)" }} aria-hidden="true" />;
  return <IconClock size={12} style={{ color: "var(--muted)" }} aria-hidden="true" />;
}

export function CredentialExportPanel() {
  const [creds, setCreds] = useState<Credential[]>([]);
  const [history, setHistory] = useState<SubmissionRecord[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  const refresh = useCallback(() => {
    loadCredentials().then(setCreds);
    setHistory(getSubmissions());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Don't render when there are no credentials
  if (creds.length === 0 && history.length === 0) return null;

  // Build summary
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const issuers = new Set<string>();

  for (const c of creds) {
    const status = proofStatus(c);
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    issuers.add(c.issuer);
  }

  const issuerList = Array.from(issuers).sort();

  const handleExport = async () => {
    setExporting(true);
    setExported(false);
    try {
      const doc = await downloadCredentialExport();
      if (doc) setExported(true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      className="card"
      style={{
        padding: "1.25rem 1.5rem",
        marginTop: "1.5rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1rem",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <IconHistory size={18} color="var(--accent)" aria-hidden="true" />
          <h3 style={{ margin: 0, fontSize: "0.95rem" }}>
            Credential history &amp; export
          </h3>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          onClick={handleExport}
          disabled={exporting || creds.length === 0}
          aria-label="Export credential history as JSON"
          title={creds.length === 0 ? "No credentials to export" : "Download a portable JSON of your credential history"}
        >
          <IconDownload size={14} aria-hidden="true" />
          {exporting ? "Exporting…" : exported ? "Exported ✓" : "Export history"}
        </button>
      </div>

      {/* ── Summary ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: "0.75rem",
          marginBottom: "1rem",
        }}
      >
        <div style={{ padding: "0.6rem 0.8rem", border: "1px solid var(--border)", borderRadius: "8px" }}>
          <div className="faint" style={{ fontSize: "0.7rem", marginBottom: "0.2rem" }}>
            Total credentials
          </div>
          <div className="mono" style={{ fontSize: "1.1rem", fontWeight: 700 }}>
            {creds.length}
          </div>
        </div>
        <div style={{ padding: "0.6rem 0.8rem", border: "1px solid var(--border)", borderRadius: "8px" }}>
          <div className="faint" style={{ fontSize: "0.7rem", marginBottom: "0.2rem" }}>
            Active proofs
          </div>
          <div className="mono" style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--accent)" }}>
            {byStatus["proved"] ?? 0}
          </div>
        </div>
        <div style={{ padding: "0.6rem 0.8rem", border: "1px solid var(--border)", borderRadius: "8px" }}>
          <div className="faint" style={{ fontSize: "0.7rem", marginBottom: "0.2rem" }}>
            Unproved
          </div>
          <div className="mono" style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--muted)" }}>
            {byStatus["unproved"] ?? 0}
          </div>
        </div>
        <div style={{ padding: "0.6rem 0.8rem", border: "1px solid var(--border)", borderRadius: "8px" }}>
          <div className="faint" style={{ fontSize: "0.7rem", marginBottom: "0.2rem" }}>
            Expired
          </div>
          <div className="mono" style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--danger)" }}>
            {byStatus["expired"] ?? 0}
          </div>
        </div>
      </div>

      {/* ── By type ── */}
      {Object.keys(byType).length > 0 && (
        <div style={{ marginBottom: "0.75rem" }}>
          <div className="faint" style={{ fontSize: "0.72rem", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            By type
          </div>
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            {Object.entries(byType).map(([type, count]) => (
              <span
                key={type}
                className="mono"
                style={{
                  fontSize: "0.75rem",
                  padding: "0.2rem 0.55rem",
                  border: "1px solid var(--border)",
                  borderRadius: "12px",
                  color: "var(--muted)",
                }}
              >
                {type}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Issuers ── */}
      {issuerList.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }}>
          <div className="faint" style={{ fontSize: "0.72rem", marginBottom: "0.3rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Issuers ({issuerList.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            {issuerList.slice(0, 5).map((issuer) => (
              <span key={issuer} className="mono" style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
                {issuer.length > 40 ? `${issuer.slice(0, 8)}…${issuer.slice(-8)}` : issuer}
              </span>
            ))}
            {issuerList.length > 5 && (
              <span className="faint" style={{ fontSize: "0.7rem" }}>
                + {issuerList.length - 5} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Submission history ── */}
      {history.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }}>
          <div className="faint" style={{ fontSize: "0.72rem", marginBottom: "0.4rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Submission history ({history.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", maxHeight: 180, overflowY: "auto" }}>
            {history.slice(0, 10).map((rec, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  padding: "0.35rem 0.55rem",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  fontSize: "0.75rem",
                }}
              >
                {statusIcon(rec.status)}
                <span className="mono" style={{ fontWeight: 600 }}>
                  {rec.credentialType}
                </span>
                <span className="faint" style={{ fontSize: "0.7rem" }}>
                  {formatDate(rec.timestamp)}
                </span>
                <span
                  className="mono faint"
                  style={{ fontSize: "0.68rem", marginLeft: "auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}
                  title={rec.txHash}
                >
                  {rec.txHash.slice(0, 10)}…
                </span>
              </div>
            ))}
            {history.length > 10 && (
              <span className="faint" style={{ fontSize: "0.7rem", textAlign: "center" }}>
                + {history.length - 10} earlier submissions
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Retention guidance ── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "0.4rem",
          padding: "0.6rem 0.75rem",
          border: "1px solid rgba(62,207,142,0.2)",
          borderRadius: "8px",
          backgroundColor: "rgba(62,207,142,0.05)",
        }}
      >
        <IconShieldCheck
          size={14}
          style={{ color: "var(--accent)", flexShrink: 0, marginTop: "0.1rem" }}
          aria-hidden="true"
        />
        <p
          className="faint"
          style={{ fontSize: "0.72rem", lineHeight: 1.5, margin: 0 }}
        >
          The export contains only public metadata — commitment hashes, issuer
          addresses, and proof status. No private attribute values or signatures
          are included. Safe to share with protocols for review. Delete when no
          longer needed.
        </p>
      </div>

      {exported && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", marginTop: "0.5rem" }}>
          <IconInfoCircle size={12} style={{ color: "var(--accent)" }} aria-hidden="true" />
          <span className="faint" style={{ fontSize: "0.72rem" }}>
            Export downloaded. Check your downloads folder.
          </span>
        </div>
      )}
    </div>
  );
}
