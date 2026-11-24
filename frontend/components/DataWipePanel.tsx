"use client";

/**
 * DataWipePanel — holder-controlled full local data wipe (#558).
 * 
 * A settings panel that lets holders remove all StellarCred state from this
 * browser in one action: credentials, proof cache, timeline, onboarding, and
 * preferences. Prompts for backup export before wiping, and shows a clear
 * confirmation dialog explaining that credentials are unrecoverable without
 * a backup.
 */

import { useState } from "react";
import { IconTrash, IconAlertTriangle, IconCheck, IconDownload } from "@tabler/icons-react";
import { wipeAllData, getWipeSummary, type WipeResult } from "@/lib/data-wipe";

export function DataWipePanel() {
  const [showConfirm, setShowConfirm] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [result, setResult] = useState<WipeResult | null>(null);

  const summary = getWipeSummary();
  const hasData =
    summary.credentials ||
    summary.proofCache ||
    summary.timelines > 0 ||
    summary.onboarding ||
    summary.wallet ||
    summary.theme;

  async function handleWipe() {
    setWiping(true);
    try {
      const wipeResult = await wipeAllData();
      setResult(wipeResult);
      setShowConfirm(false);

      // If successful, reload the page after a brief delay to reflect the wiped state
      if (wipeResult.success) {
        setTimeout(() => {
          window.location.reload();
        }, 2000);
      }
    } catch (err) {
      setResult({
        success: false,
        keysRemoved: 0,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setWiping(false);
    }
  }

  return (
    <div className="stack" style={{ gap: "1rem" }}>
      <div>
        <h3 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.5rem" }}>
          Data Management
        </h3>
        <p style={{ fontSize: "0.875rem", color: "var(--faint)", lineHeight: 1.6 }}>
          Remove all StellarCred data from this browser. This includes your credentials, proof
          cache, timeline history, onboarding state, wallet connection, and preferences.
        </p>
      </div>

      {/* Current storage summary */}
      {hasData && (
        <div
          className="card"
          style={{
            padding: "0.875rem 1rem",
            backgroundColor: "var(--card)",
            border: "1px solid var(--border)",
          }}
        >
          <div style={{ fontSize: "0.8rem", color: "var(--faint)", marginBottom: "0.5rem", fontWeight: 600 }}>
            Current Storage
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.8rem" }}>
            {summary.credentials && (
              <div className="row" style={{ gap: "0.4rem" }}>
                <IconCheck size={14} style={{ color: "var(--accent)" }} />
                <span>Encrypted credentials</span>
              </div>
            )}
            {summary.proofCache && (
              <div className="row" style={{ gap: "0.4rem" }}>
                <IconCheck size={14} style={{ color: "var(--accent)" }} />
                <span>Proof cache</span>
              </div>
            )}
            {summary.timelines > 0 && (
              <div className="row" style={{ gap: "0.4rem" }}>
                <IconCheck size={14} style={{ color: "var(--accent)" }} />
                <span>{summary.timelines} timeline{summary.timelines > 1 ? "s" : ""}</span>
              </div>
            )}
            {summary.onboarding && (
              <div className="row" style={{ gap: "0.4rem" }}>
                <IconCheck size={14} style={{ color: "var(--accent)" }} />
                <span>Onboarding state</span>
              </div>
            )}
            {summary.wallet && (
              <div className="row" style={{ gap: "0.4rem" }}>
                <IconCheck size={14} style={{ color: "var(--accent)" }} />
                <span>Wallet connection</span>
              </div>
            )}
            {summary.theme && (
              <div className="row" style={{ gap: "0.4rem" }}>
                <IconCheck size={14} style={{ color: "var(--accent)" }} />
                <span>Theme preference</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Wipe button */}
      <button
        className="btn btn-danger"
        onClick={() => setShowConfirm(true)}
        disabled={!hasData || wiping}
        style={{ alignSelf: "flex-start" }}
      >
        <IconTrash size={16} />
        {wiping ? "Wiping data..." : "Wipe all data"}
      </button>

      {!hasData && (
        <p style={{ fontSize: "0.8rem", color: "var(--faint)", fontStyle: "italic" }}>
          No StellarCred data found in this browser.
        </p>
      )}

      {/* Success/error message */}
      {result && (
        <div
          className="card"
          style={{
            padding: "0.875rem 1rem",
            backgroundColor: result.success
              ? "rgba(62, 207, 142, 0.08)"
              : "rgba(239, 68, 68, 0.08)",
            border: `1px solid ${result.success ? "rgba(62, 207, 142, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
          }}
        >
          <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
            {result.success ? (
              <IconCheck size={18} style={{ color: "var(--accent)" }} />
            ) : (
              <IconAlertTriangle size={18} style={{ color: "var(--danger)" }} />
            )}
            <div>
              <div style={{ fontSize: "0.875rem", fontWeight: 600 }}>
                {result.success
                  ? `Successfully wiped ${result.keysRemoved} storage key${result.keysRemoved !== 1 ? "s" : ""}`
                  : "Wipe failed"}
              </div>
              {result.error && (
                <div style={{ fontSize: "0.8rem", color: "var(--faint)", marginTop: "0.25rem" }}>
                  {result.error}
                </div>
              )}
              {result.success && result.backup && (
                <div style={{ fontSize: "0.8rem", color: "var(--faint)", marginTop: "0.25rem" }}>
                  <IconDownload size={12} style={{ display: "inline", marginRight: "0.25rem" }} />
                  Backup downloaded before wipe
                </div>
              )}
              {result.success && (
                <div style={{ fontSize: "0.8rem", color: "var(--faint)", marginTop: "0.25rem" }}>
                  Refreshing page...
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirmation modal */}
      {showConfirm && (
        <div
          className="modal-backdrop"
          onClick={() => !wiping && setShowConfirm(false)}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "32rem",
              padding: "1.5rem",
              margin: "1rem",
            }}
          >
            <div className="row" style={{ gap: "0.75rem", marginBottom: "1rem", alignItems: "flex-start" }}>
              <IconAlertTriangle size={24} style={{ color: "var(--danger)", flexShrink: 0 }} />
              <div>
                <h3 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.5rem" }}>
                  Wipe all local data?
                </h3>
                <div style={{ fontSize: "0.875rem", color: "var(--faint)", lineHeight: 1.6 }}>
                  <p style={{ margin: "0 0 0.75rem" }}>
                    This will permanently remove all StellarCred data from this browser:
                  </p>
                  <ul style={{ margin: "0 0 0.75rem", paddingLeft: "1.25rem" }}>
                    <li>Your encrypted credentials (unrecoverable without a backup)</li>
                    <li>Proof cache and timeline history</li>
                    <li>Onboarding progress</li>
                    <li>Wallet connection</li>
                    <li>Theme preference</li>
                  </ul>
                  <p style={{ margin: "0.75rem 0 0", fontWeight: 600, color: "var(--danger)" }}>
                    Your credentials will be backed up as a JSON file before wiping. Keep this
                    file safe — it&apos;s your only way to restore them.
                  </p>
                </div>
              </div>
            </div>

            <div className="row" style={{ gap: "0.75rem", justifyContent: "flex-end", marginTop: "1.5rem" }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowConfirm(false)}
                disabled={wiping}
              >
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleWipe} disabled={wiping}>
                {wiping ? "Wiping..." : "Wipe all data"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
