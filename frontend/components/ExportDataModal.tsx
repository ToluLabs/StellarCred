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

/**
 * Integrity metadata attached to every exported bundle.
 * The checksum is a SHA-256 digest of the canonical JSON payload, so any
 * tampering with the bundle contents is detectable on import.
 */
export interface BundleIntegrity {
  algorithm: "SHA-256";
  checksum: string;
  createdAt: string;
  scope: string;
  format: string;
  version: 1;
}

export interface ExportBundle {
  integrity: BundleIntegrity;
  payload: unknown;
}

export type BundleValidationResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "checksum_mismatch" | "unsupported_version" | "scope_mismatch"; message: string };

/** Deterministic JSON serialization (sorted object keys) for stable hashing. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build an integrity-wrapped bundle for export. */
export async function createExportBundle(
  payload: unknown,
  scope: string,
  format: string,
): Promise<ExportBundle> {
  const checksum = await sha256Hex(canonicalize(payload));
  return {
    integrity: {
      algorithm: "SHA-256",
      checksum,
      createdAt: new Date().toISOString(),
      scope,
      format,
      version: 1,
    },
    payload,
  };
}

/**
 * Validate a bundle before import. Rejects malformed, corrupt, or mismatched
 * bundles with a user-friendly message. Optionally enforces an expected scope
 * so a bundle exported for one scope cannot be applied under another.
 */
export async function validateImportBundle(
  raw: unknown,
  expectedScope?: string,
): Promise<BundleValidationResult> {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      reason: "malformed",
      message: "This file is not a valid export bundle. Choose a file exported from this app.",
    };
  }
  const bundle = raw as Partial<ExportBundle>;
  const integrity = bundle.integrity;
  if (!integrity || !("payload" in bundle)) {
    return {
      ok: false,
      reason: "malformed",
      message: "The export file is missing its integrity information and cannot be imported.",
    };
  }
  if (integrity.version !== 1 || integrity.algorithm !== "SHA-256") {
    return {
      ok: false,
      reason: "unsupported_version",
      message: "This export was created by an unsupported version of the app. Re-export it from a current build.",
    };
  }
  if (expectedScope && integrity.scope !== expectedScope) {
    return {
      ok: false,
      reason: "scope_mismatch",
      message: `This bundle is a "${integrity.scope}" export, but "${expectedScope}" was expected. Import was cancelled to avoid applying the wrong data.`,
    };
  }
  const actual = await sha256Hex(canonicalize(bundle.payload));
  if (actual !== integrity.checksum) {
    return {
      ok: false,
      reason: "checksum_mismatch",
      message: "The export file appears to be corrupted or has been modified. Import was cancelled. Download a fresh export and try again.",
    };
  }
  return { ok: true };
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
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
