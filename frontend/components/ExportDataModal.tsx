"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  IconX,
  IconDownload,
  IconClock,
  IconLoader2,
  IconCheck,
  IconAlertTriangle,
  IconLock,
  IconRefresh,
  IconFileText,
  IconFileSpreadsheet,
  IconShield,
  IconFileExport,
} from "@tabler/icons-react";
import type { ExportJob, ExportScope, ExportFormat, ScopeDefinition } from "@/lib/export-jobs";
import { EXPORT_SCOPES } from "@/lib/export-jobs";

interface ExportDataModalProps {
  isOpen: boolean;
  onClose: () => void;
  userAddress?: string;
  isAdmin?: boolean;
}

export function ExportDataModal({
  isOpen,
  onClose,
  userAddress,
  isAdmin = false,
}: ExportDataModalProps) {
  const [activeTab, setActiveTab] = useState<"request" | "monitor">("request");
  const [selectedScope, setSelectedScope] = useState<ExportScope>("full");
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>("json");
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [allowedScopes, setAllowedScopes] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [timeRemainingMap, setTimeRemainingMap] = useState<Record<string, number>>({});

  const fetchJobs = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      if (userAddress) headers["x-user-address"] = userAddress;
      if (isAdmin) headers["x-user-role"] = "admin";

      const res = await fetch("/api/export", { headers });
      if (!res.ok) throw new Error("Failed to fetch export history");
      const data = await res.json();
      setJobs(data.jobs || []);
      setAllowedScopes(data.allowedScopes || []);
    } catch (err: unknown) {
      console.warn("Error loading export jobs:", err);
    }
  }, [userAddress, isAdmin]);

  useEffect(() => {
    if (isOpen) {
      setLoadingJobs(true);
      fetchJobs().finally(() => setLoadingJobs(false));
    }
  }, [isOpen, fetchJobs]);

  // Poll active jobs every 2 seconds
  useEffect(() => {
    if (!isOpen) return;

    const hasActive = jobs.some((j) => j.status === "pending" || j.status === "processing");
    if (!hasActive) return;

    const interval = setInterval(() => {
      fetchJobs();
    }, 2000);

    return () => clearInterval(interval);
  }, [isOpen, jobs, fetchJobs]);

  // Expiration countdown ticker
  useEffect(() => {
    if (!isOpen) return;

    const tick = () => {
      const now = Date.now();
      const updated: Record<string, number> = {};
      for (const job of jobs) {
        if (job.expiresAt) {
          const diffSec = Math.max(0, Math.floor((job.expiresAt - now) / 1000));
          updated[job.id] = diffSec;
        }
      }
      setTimeRemainingMap(updated);
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isOpen, jobs]);

  if (!isOpen) return null;

  async function handleRequestExport(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessNotice(null);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (userAddress) headers["x-user-address"] = userAddress;
      if (isAdmin) headers["x-user-role"] = "admin";

      const res = await fetch("/api/export", {
        method: "POST",
        headers,
        body: JSON.stringify({
          scope: selectedScope,
          format: selectedFormat,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create export request");
      }

      setSuccessNotice(`Export job requested successfully! Processing ${selectedScope} archive.`);
      setActiveTab("monitor");
      await fetchJobs();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Request failed";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  function formatCountdown(seconds: number): string {
    if (seconds <= 0) return "Expired";
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs.toString().padStart(2, "0")}s`;
  }

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
        padding: "1rem",
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "40rem",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          padding: "1.75rem",
          boxShadow: "0 20px 40px rgba(0,0,0,0.4)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius, 12px)",
          backgroundColor: "var(--card, #111)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div className="between" style={{ marginBottom: "1.25rem", alignItems: "center" }}>
          <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: "8px",
                display: "grid",
                placeItems: "center",
                backgroundColor: "rgba(62,207,142,0.12)",
                color: "var(--accent, #3ecf8e)",
              }}
            >
              <IconFileExport size={20} />
            </div>
            <div>
              <h2
                id="export-modal-title"
                style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0, lineHeight: 1.2 }}
              >
                Export User Data
              </h2>
              <span style={{ fontSize: "0.775rem", color: "var(--faint, #888)" }}>
                Request scoped exports & monitor expiring download links
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="Close export dialog"
            style={{ padding: "0.4rem", borderRadius: "6px" }}
          >
            <IconX size={18} />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div
          role="tablist"
          style={{
            display: "flex",
            gap: "0.5rem",
            borderBottom: "1px solid var(--border)",
            marginBottom: "1.25rem",
            paddingBottom: "0.25rem",
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "request"}
            className={`btn btn-sm ${activeTab === "request" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setActiveTab("request")}
            id="tab-request-export"
          >
            Request Export
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "monitor"}
            className={`btn btn-sm ${activeTab === "monitor" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setActiveTab("monitor")}
            id="tab-monitor-exports"
          >
            Export History & Status
            {jobs.length > 0 && (
              <span
                style={{
                  marginLeft: "0.4rem",
                  padding: "0.1rem 0.45rem",
                  fontSize: "0.7rem",
                  borderRadius: "99px",
                  background: "rgba(255,255,255,0.12)",
                }}
              >
                {jobs.length}
              </span>
            )}
          </button>
        </div>

        {/* Notices */}
        {error && (
          <div
            role="alert"
            style={{
              padding: "0.75rem 1rem",
              borderRadius: "8px",
              backgroundColor: "rgba(239, 68, 68, 0.1)",
              border: "1px solid rgba(239, 68, 68, 0.3)",
              color: "var(--danger, #ef4444)",
              fontSize: "0.825rem",
              marginBottom: "1rem",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <IconAlertTriangle size={16} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        {successNotice && (
          <div
            role="status"
            style={{
              padding: "0.75rem 1rem",
              borderRadius: "8px",
              backgroundColor: "rgba(62, 207, 142, 0.1)",
              border: "1px solid rgba(62, 207, 142, 0.3)",
              color: "var(--accent, #3ecf8e)",
              fontSize: "0.825rem",
              marginBottom: "1rem",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <IconCheck size={16} style={{ flexShrink: 0 }} />
            <span>{successNotice}</span>
          </div>
        )}

        {/* Tab 1: Request Export Form */}
        {activeTab === "request" && (
          <form
            onSubmit={handleRequestExport}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1.25rem",
              overflowY: "auto",
              paddingRight: "0.25rem",
            }}
          >
            {/* Scope Selection */}
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.825rem",
                  fontWeight: 600,
                  marginBottom: "0.5rem",
                  color: "var(--text)",
                }}
              >
                Select Export Scope
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "0.55rem" }}>
                {EXPORT_SCOPES.map((scopeDef: ScopeDefinition) => {
                  const isPermitted =
                    allowedScopes.length === 0 || allowedScopes.includes(scopeDef.id);
                  const isSelected = selectedScope === scopeDef.id;

                  return (
                    <div
                      key={scopeDef.id}
                      onClick={() => isPermitted && setSelectedScope(scopeDef.id)}
                      id={`scope-option-${scopeDef.id}`}
                      style={{
                        padding: "0.75rem 0.9rem",
                        borderRadius: "8px",
                        border: `1px solid ${
                          isSelected ? "var(--accent, #3ecf8e)" : "var(--border)"
                        }`,
                        backgroundColor: isSelected
                          ? "rgba(62, 207, 142, 0.06)"
                          : isPermitted
                          ? "var(--card-subtle, rgba(255,255,255,0.02))"
                          : "rgba(0,0,0,0.2)",
                        opacity: isPermitted ? 1 : 0.5,
                        cursor: isPermitted ? "pointer" : "not-allowed",
                        transition: "border-color 0.15s, background-color 0.15s",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "0.75rem",
                      }}
                    >
                      <input
                        type="radio"
                        name="exportScope"
                        checked={isSelected}
                        disabled={!isPermitted}
                        onChange={() => isPermitted && setSelectedScope(scopeDef.id)}
                        style={{ marginTop: "0.2rem" }}
                      />
                      <div style={{ flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.5rem",
                            marginBottom: "0.2rem",
                          }}
                        >
                          <span style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                            {scopeDef.label}
                          </span>
                          {scopeDef.requiresAdmin && (
                            <span
                              style={{
                                fontSize: "0.675rem",
                                padding: "0.1rem 0.4rem",
                                borderRadius: "4px",
                                backgroundColor: "rgba(234, 179, 8, 0.15)",
                                color: "var(--warn, #eab308)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.2rem",
                              }}
                            >
                              <IconLock size={10} />
                              Admin Only
                            </span>
                          )}
                          {!isPermitted && (
                            <span
                              style={{
                                fontSize: "0.675rem",
                                color: "var(--danger, #ef4444)",
                              }}
                            >
                              (Unauthorized)
                            </span>
                          )}
                        </div>
                        <p
                          style={{
                            margin: 0,
                            fontSize: "0.75rem",
                            color: "var(--faint, #888)",
                            lineHeight: 1.4,
                          }}
                        >
                          {scopeDef.description}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Format Selection */}
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.825rem",
                  fontWeight: 600,
                  marginBottom: "0.5rem",
                  color: "var(--text)",
                }}
              >
                Select Format
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                <div
                  onClick={() => setSelectedFormat("json")}
                  id="format-option-json"
                  style={{
                    padding: "0.85rem",
                    borderRadius: "8px",
                    border: `1px solid ${
                      selectedFormat === "json" ? "var(--accent, #3ecf8e)" : "var(--border)"
                    }`,
                    backgroundColor:
                      selectedFormat === "json"
                        ? "rgba(62, 207, 142, 0.06)"
                        : "var(--card-subtle, rgba(255,255,255,0.02))",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                  }}
                >
                  <IconFileText size={20} style={{ color: "var(--accent, #3ecf8e)" }} />
                  <div>
                    <div style={{ fontSize: "0.875rem", fontWeight: 600 }}>JSON</div>
                    <div style={{ fontSize: "0.725rem", color: "var(--faint, #888)" }}>
                      Schema v1 (machine-readable)
                    </div>
                  </div>
                </div>

                <div
                  onClick={() => setSelectedFormat("csv")}
                  id="format-option-csv"
                  style={{
                    padding: "0.85rem",
                    borderRadius: "8px",
                    border: `1px solid ${
                      selectedFormat === "csv" ? "var(--accent, #3ecf8e)" : "var(--border)"
                    }`,
                    backgroundColor:
                      selectedFormat === "csv"
                        ? "rgba(62, 207, 142, 0.06)"
                        : "var(--card-subtle, rgba(255,255,255,0.02))",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.6rem",
                  }}
                >
                  <IconFileSpreadsheet size={20} style={{ color: "var(--accent, #3ecf8e)" }} />
                  <div>
                    <div style={{ fontSize: "0.875rem", fontWeight: 600 }}>CSV</div>
                    <div style={{ fontSize: "0.725rem", color: "var(--faint, #888)" }}>
                      Spreadsheet compatible
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Security Notice */}
            <div
              style={{
                padding: "0.75rem 0.9rem",
                borderRadius: "8px",
                backgroundColor: "rgba(255,255,255,0.03)",
                border: "1px solid var(--border)",
                fontSize: "0.75rem",
                color: "var(--faint, #888)",
                display: "flex",
                gap: "0.5rem",
                lineHeight: 1.5,
              }}
            >
              <IconShield size={16} style={{ color: "var(--accent, #3ecf8e)", flexShrink: 0 }} />
              <span>
                Download links are cryptographically signed and expire after 5 minutes.
                Exports contain sensitive cryptographic commitments; store backups securely.
              </span>
            </div>

            {/* Submit Action */}
            <div className="row" style={{ justifyContent: "flex-end", gap: "0.75rem", marginTop: "0.5rem" }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting}
                id="btn-submit-export"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
              >
                {submitting ? (
                  <>
                    <IconLoader2 size={16} className="spin" />
                    Requesting...
                  </>
                ) : (
                  <>
                    <IconFileExport size={16} />
                    Request Export
                  </>
                )}
              </button>
            </div>
          </form>
        )}

        {/* Tab 2: Export History & Monitoring */}
        {activeTab === "monitor" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
              overflowY: "auto",
              flex: 1,
            }}
          >
            <div className="between" style={{ alignItems: "center" }}>
              <span style={{ fontSize: "0.825rem", color: "var(--faint, #888)" }}>
                Export jobs are processed asynchronously and available for download upon completion.
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => fetchJobs()}
                disabled={loadingJobs}
                title="Refresh jobs"
                style={{ padding: "0.3rem 0.5rem", fontSize: "0.75rem" }}
              >
                <IconRefresh size={14} className={loadingJobs ? "spin" : ""} />
                Refresh
              </button>
            </div>

            {loadingJobs && jobs.length === 0 ? (
              <div style={{ textAlign: "center", padding: "2.5rem 0", color: "var(--faint)" }}>
                <IconLoader2 size={24} className="spin" style={{ margin: "0 auto 0.5rem" }} />
                <p style={{ fontSize: "0.85rem", margin: 0 }}>Loading export status...</p>
              </div>
            ) : jobs.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "3rem 1.5rem",
                  border: "1px dashed var(--border)",
                  borderRadius: "8px",
                  color: "var(--faint)",
                }}
              >
                <IconFileExport size={28} style={{ opacity: 0.5, marginBottom: "0.5rem" }} />
                <h4 style={{ fontSize: "0.95rem", margin: "0 0 0.3rem", color: "var(--text)" }}>
                  No exports requested yet
                </h4>
                <p style={{ fontSize: "0.8rem", margin: "0 0 1rem" }}>
                  Select your required scope and format from the Request tab to generate an archive.
                </p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setActiveTab("request")}
                >
                  Create First Export
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {jobs.map((job) => {
                  const remainingSec = timeRemainingMap[job.id] ?? 0;
                  const isExpired = job.expiresAt ? remainingSec <= 0 : false;

                  return (
                    <div
                      key={job.id}
                      id={`export-job-${job.id}`}
                      style={{
                        padding: "0.9rem 1rem",
                        borderRadius: "8px",
                        backgroundColor: "rgba(255,255,255,0.02)",
                        border: "1px solid var(--border)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.6rem",
                      }}
                    >
                      <div className="between" style={{ alignItems: "center" }}>
                        <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
                          <span
                            style={{
                              fontSize: "0.85rem",
                              fontWeight: 600,
                              textTransform: "capitalize",
                            }}
                          >
                            {job.scope.replace("_", " ")}
                          </span>
                          <span
                            className="mono"
                            style={{
                              fontSize: "0.7rem",
                              padding: "0.1rem 0.35rem",
                              borderRadius: "4px",
                              backgroundColor: "rgba(255,255,255,0.08)",
                              textTransform: "uppercase",
                            }}
                          >
                            {job.format}
                          </span>
                        </div>

                        {/* Status Badge */}
                        <div>
                          {job.status === "pending" && (
                            <span
                              style={{
                                fontSize: "0.75rem",
                                padding: "0.2rem 0.5rem",
                                borderRadius: "99px",
                                backgroundColor: "rgba(234, 179, 8, 0.15)",
                                color: "var(--warn, #eab308)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.3rem",
                              }}
                            >
                              <IconClock size={12} />
                              Pending
                            </span>
                          )}
                          {job.status === "processing" && (
                            <span
                              style={{
                                fontSize: "0.75rem",
                                padding: "0.2rem 0.5rem",
                                borderRadius: "99px",
                                backgroundColor: "rgba(59, 130, 246, 0.15)",
                                color: "#3b82f6",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.3rem",
                              }}
                            >
                              <IconLoader2 size={12} className="spin" />
                              Processing {job.progress}%
                            </span>
                          )}
                          {job.status === "ready" && !isExpired && (
                            <span
                              style={{
                                fontSize: "0.75rem",
                                padding: "0.2rem 0.5rem",
                                borderRadius: "99px",
                                backgroundColor: "rgba(62, 207, 142, 0.15)",
                                color: "var(--accent, #3ecf8e)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.3rem",
                              }}
                            >
                              <IconCheck size={12} />
                              Ready
                            </span>
                          )}
                          {job.status === "ready" && isExpired && (
                            <span
                              style={{
                                fontSize: "0.75rem",
                                padding: "0.2rem 0.5rem",
                                borderRadius: "99px",
                                backgroundColor: "rgba(255, 255, 255, 0.1)",
                                color: "var(--faint, #888)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.3rem",
                              }}
                            >
                              <IconClock size={12} />
                              Link Expired
                            </span>
                          )}
                          {job.status === "failed" && (
                            <span
                              style={{
                                fontSize: "0.75rem",
                                padding: "0.2rem 0.5rem",
                                borderRadius: "99px",
                                backgroundColor: "rgba(239, 68, 68, 0.15)",
                                color: "var(--danger, #ef4444)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.3rem",
                              }}
                            >
                              <IconAlertTriangle size={12} />
                              Failed
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Job Metadata & Download Row */}
                      <div className="between" style={{ alignItems: "center", fontSize: "0.75rem" }}>
                        <span style={{ color: "var(--faint, #888)" }}>
                          Requested: {new Date(job.createdAt).toLocaleTimeString()} · Job ID:{" "}
                          <span className="mono">{job.id.slice(0, 10)}</span>
                        </span>

                        {job.status === "ready" && !isExpired && job.downloadUrl && (
                          <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
                            <span
                              style={{
                                fontSize: "0.7rem",
                                color: "var(--warn, #eab308)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.25rem",
                              }}
                            >
                              <IconClock size={12} />
                              {formatCountdown(remainingSec)}
                            </span>
                            <a
                              href={job.downloadUrl}
                              download
                              className="btn btn-primary btn-sm"
                              id={`btn-download-${job.id}`}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.3rem",
                                textDecoration: "none",
                                padding: "0.25rem 0.65rem",
                                fontSize: "0.75rem",
                              }}
                            >
                              <IconDownload size={13} />
                              Download
                            </a>
                          </div>
                        )}

                        {job.status === "ready" && isExpired && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              setSelectedScope(job.scope);
                              setSelectedFormat(job.format);
                              setActiveTab("request");
                            }}
                            style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                          >
                            Re-request
                          </button>
                        )}
                      </div>

                      {job.error && (
                        <div
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--danger, #ef4444)",
                            backgroundColor: "rgba(239, 68, 68, 0.08)",
                            padding: "0.4rem 0.6rem",
                            borderRadius: "4px",
                          }}
                        >
                          Error: {job.error}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
