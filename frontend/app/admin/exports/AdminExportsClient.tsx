"use client";

import { useState } from "react";
import type { ExportRecord } from "@/lib/export-store";
import type { AuditLogEntry } from "@/lib/audit-log";
import { revokeExportAction } from "./actions";

interface AdminExportsClientProps {
  initialExports: ExportRecord[];
  initialAuditEntries: AuditLogEntry[];
  initialChainValid: boolean;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + "…";
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AdminExportsClient({
  initialExports,
  initialAuditEntries,
  initialChainValid,
}: AdminExportsClientProps) {
  const [exports, setExports] = useState<ExportRecord[]>(initialExports);
  const [auditEntries, setAuditEntries] =
    useState<AuditLogEntry[]>(initialAuditEntries);
  const [chainValid, setChainValid] = useState<boolean>(initialChainValid);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [showAudit, setShowAudit] = useState(false);

  async function handleRevoke(id: string): Promise<void> {
    const adminId = window.prompt("Enter your admin ID:");
    if (!adminId || !adminId.trim()) return;

    setRevoking(id);
    try {
      const result = await revokeExportAction(id, adminId.trim());
      if (!result.success) {
        alert("Revoke failed: " + result.error);
        return;
      }

      setExports((prev) =>
        prev.map((r) => (r.id === id ? result.record : r)),
      );
      setAuditEntries(result.auditEntries);
      setChainValid(result.chainValid);
    } catch (err) {
      alert("Revoke failed: " + (err as Error).message);
    } finally {
      setRevoking(null);
    }
  }

  const visibleAuditEntries = auditEntries.slice().reverse().slice(0, 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Section 1: Export Records */}
      <section aria-labelledby="exports-heading">
        <h2
          id="exports-heading"
          style={{
            fontSize: "1.1rem",
            marginBottom: "1rem",
            color: "var(--text)",
          }}
        >
          Export Records
        </h2>

        {exports.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>No export records found.</p>
        ) : (
          <div
            style={{
              overflowX: "auto",
              border: "1px solid var(--border)",
              borderRadius: "8px",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                backgroundColor: "var(--card)",
                color: "var(--text)",
              }}
            >
              <caption
                style={{
                  position: "absolute",
                  width: "1px",
                  height: "1px",
                  overflow: "hidden",
                  clip: "rect(0 0 0 0)",
                  whiteSpace: "nowrap",
                }}
              >
                Export records with revocation controls
              </caption>
              <thead>
                <tr
                  style={{
                    borderBottom: "1px solid var(--border)",
                    backgroundColor: "var(--bg-soft, var(--bg))",
                  }}
                >
                  {[
                    "ID",
                    "Credential Type",
                    "Issuer",
                    "Requested At",
                    "Status",
                    "Actions",
                  ].map((col) => (
                    <th
                      key={col}
                      scope="col"
                      style={{
                        padding: "0.75rem 1rem",
                        textAlign: "left",
                        fontSize: "0.8rem",
                        fontWeight: 600,
                        color: "var(--muted)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {exports.map((record) => (
                  <tr
                    key={record.id}
                    style={{
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <th
                      scope="row"
                      style={{
                        padding: "0.75rem 1rem",
                        fontWeight: "normal",
                        fontFamily: "monospace",
                        fontSize: "0.85rem",
                        color: "var(--muted)",
                      }}
                    >
                      {truncate(record.id, 8)}
                    </th>
                    <td style={{ padding: "0.75rem 1rem", fontSize: "0.9rem" }}>
                      {record.credentialType}
                    </td>
                    <td
                      style={{
                        padding: "0.75rem 1rem",
                        fontFamily: "monospace",
                        fontSize: "0.85rem",
                        color: "var(--muted)",
                      }}
                    >
                      {truncate(record.issuer, 12)}
                    </td>
                    <td
                      style={{
                        padding: "0.75rem 1rem",
                        fontSize: "0.85rem",
                        color: "var(--muted)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatDate(record.requestedAt)}
                    </td>
                    <td style={{ padding: "0.75rem 1rem" }}>
                      {record.revokedAt ? (
                        <span
                          style={{
                            display: "inline-block",
                            padding: "0.2rem 0.6rem",
                            borderRadius: "4px",
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            background: "rgba(240, 96, 77, 0.1)",
                            color: "var(--danger)",
                          }}
                        >
                          Revoked
                        </span>
                      ) : (
                        <span
                          style={{
                            display: "inline-block",
                            padding: "0.2rem 0.6rem",
                            borderRadius: "4px",
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            background: "var(--accent-soft)",
                            color: "var(--accent)",
                          }}
                        >
                          Active
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "0.75rem 1rem" }}>
                      <button
                        onClick={() => void handleRevoke(record.id)}
                        disabled={
                          record.revokedAt !== null || revoking === record.id
                        }
                        aria-label={`Revoke export ${truncate(record.id, 8)}`}
                        style={{
                          padding: "0.3rem 0.75rem",
                          fontSize: "0.8rem",
                          border: "1px solid var(--danger)",
                          color: "var(--danger)",
                          background: "transparent",
                          borderRadius: "6px",
                          cursor:
                            record.revokedAt !== null || revoking === record.id
                              ? "not-allowed"
                              : "pointer",
                          opacity:
                            record.revokedAt !== null || revoking === record.id
                              ? 0.5
                              : 1,
                        }}
                      >
                        {revoking === record.id ? "Revoking…" : "Revoke"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 2: Chain integrity banner */}
      <section aria-label="Audit chain integrity status">
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "8px",
            fontSize: "0.9rem",
            fontWeight: 500,
            background: chainValid
              ? "var(--accent-soft)"
              : "rgba(240, 96, 77, 0.1)",
            color: chainValid ? "var(--accent)" : "var(--danger)",
            border: `1px solid ${
              chainValid ? "var(--accent)" : "var(--danger)"
            }`,
          }}
        >
          {chainValid
            ? "✓ Audit chain integrity verified"
            : "⚠ Chain integrity check failed — log may have been tampered with"}
        </div>
      </section>

      {/* Section 3: Audit log */}
      <section aria-labelledby="audit-heading">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            marginBottom: "1rem",
          }}
        >
          <h2
            id="audit-heading"
            style={{ fontSize: "1.1rem", color: "var(--text)", margin: 0 }}
          >
            Audit Log
          </h2>
          <button
            onClick={() => setShowAudit((v) => !v)}
            aria-expanded={showAudit}
            aria-controls="audit-log-table"
            style={{
              padding: "0.3rem 0.75rem",
              fontSize: "0.8rem",
              border: "1px solid var(--border)",
              color: "var(--muted)",
              background: "transparent",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            {showAudit ? "Hide" : "Show"} Audit Log
          </button>
        </div>

        {showAudit && (
          <div
            id="audit-log-table"
            style={{
              overflowX: "auto",
              border: "1px solid var(--border)",
              borderRadius: "8px",
            }}
          >
            {visibleAuditEntries.length === 0 ? (
              <p
                style={{
                  padding: "1rem",
                  color: "var(--muted)",
                  margin: 0,
                }}
              >
                No audit entries yet.
              </p>
            ) : (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  backgroundColor: "var(--card)",
                  color: "var(--text)",
                  fontSize: "0.85rem",
                }}
              >
                <caption
                  style={{
                    position: "absolute",
                    width: "1px",
                    height: "1px",
                    overflow: "hidden",
                    clip: "rect(0 0 0 0)",
                    whiteSpace: "nowrap",
                  }}
                >
                  Audit log entries (most recent first)
                </caption>
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid var(--border)",
                      backgroundColor: "var(--bg-soft, var(--bg))",
                    }}
                  >
                    {[
                      "#",
                      "Timestamp",
                      "Request ID",
                      "Issuer",
                      "Commitment",
                      "Admin Action",
                    ].map((col) => (
                      <th
                        key={col}
                        scope="col"
                        style={{
                          padding: "0.6rem 0.75rem",
                          textAlign: "left",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          color: "var(--muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleAuditEntries.map((entry) => (
                    <tr
                      key={`${entry.index}-${entry.hash}`}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <td
                        style={{
                          padding: "0.6rem 0.75rem",
                          color: "var(--faint)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {entry.index}
                      </td>
                      <td
                        style={{
                          padding: "0.6rem 0.75rem",
                          color: "var(--muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {new Date(entry.timestamp).toISOString()}
                      </td>
                      <td
                        style={{
                          padding: "0.6rem 0.75rem",
                          fontFamily: "monospace",
                          color: "var(--muted)",
                        }}
                      >
                        {truncate(entry.requestId, 12)}
                      </td>
                      <td
                        style={{
                          padding: "0.6rem 0.75rem",
                          fontFamily: "monospace",
                          color: "var(--muted)",
                        }}
                      >
                        {truncate(entry.issuer, 12)}
                      </td>
                      <td
                        style={{
                          padding: "0.6rem 0.75rem",
                          fontFamily: "monospace",
                          color: "var(--muted)",
                        }}
                      >
                        {truncate(entry.commitment, 12)}
                      </td>
                      <td
                        style={{
                          padding: "0.6rem 0.75rem",
                          color: entry.adminAction
                            ? "var(--warn)"
                            : "var(--faint)",
                        }}
                      >
                        {entry.adminAction ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
