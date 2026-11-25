"use client";

import { useEffect, useRef, useState } from "react";
import { IconAlertTriangle, IconCheck, IconTrash } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useWallet } from "@/lib/wallet-context";
import { eraseCredentials, type EraseResult } from "@/lib/credential-erasure";

export function CredentialErasurePanel() {
  const { address } = useWallet();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EraseResult | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement;
    } else if (previousFocusRef.current) {
      (previousFocusRef.current as HTMLElement).focus();
      previousFocusRef.current = null;
    }
  }, [open]);

  async function handleErase() {
    setBusy(true);
    setResult(null);
    try {
      const res = await eraseCredentials();
      setResult(res);
      if (res.success) {
        toast.success(
          res.locationsRemoved > 0
            ? `Removed credential data from ${res.locationsRemoved} storage location(s).`
            : "No credential data was present to remove.",
        );
      } else if (res.message) {
        toast.error(res.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!address) {
    return (
      <p style={{ fontSize: "0.8rem", color: "var(--faint)", fontStyle: "italic" }}>
        Connect a wallet to manage credential erasure.
      </p>
    );
  }

  return (
    <div>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(true)}
        id="btn-erase-credentials-action"
        style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
      >
        <IconTrash size={14} />
        Erase locally stored credentials
      </button>

      {open && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => !busy && setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1100,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="erase-modal-title"
            aria-describedby="erase-modal-desc"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#18181b",
              border: "1px solid #27272a",
              borderRadius: "12px",
              padding: "1.5rem",
              maxWidth: "420px",
              width: "90%",
              maxHeight: "85vh",
              overflowY: "auto",
            }}
            tabIndex={-1}
          >
            <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", marginBottom: "1rem" }}>
              <IconAlertTriangle size={24} style={{ color: "var(--danger)", flexShrink: 0 }} />
              <div>
                <h3 id="erase-modal-title" style={{ marginTop: 0, fontSize: "1.1rem" }}>
                  Erase locally stored credentials?
                </h3>
                <p
                  id="erase-modal-desc"
                  style={{ fontSize: "0.875rem", color: "var(--faint)", lineHeight: 1.6 }}
                >
                  This will permanently remove credential values and salts stored in this browser&apos;s local storage. This cannot be undone. Wallet disconnection alone does not erase credentials.
                </p>
              </div>
            </div>

            <div id="erase-result" aria-live="polite" style={{ fontSize: "0.8rem", color: "var(--faint)", marginBottom: "1rem" }}>
              {result !== null && (
                <div style={{
                  background: result.success ? "rgba(62,207,142,0.08)" : "rgba(239,68,68,0.08)",
                  border: `1px solid ${result.success ? "rgba(62,207,142,0.3)" : "rgba(239,68,68,0.3)"}`,
                  borderRadius: "8px",
                  padding: "0.75rem",
                  marginBottom: "0.75rem",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    {result.success ? (
                      <IconCheck size={14} style={{ color: "var(--accent)" }} />
                    ) : (
                      <IconAlertTriangle size={14} style={{ color: "var(--danger)" }} />
                    )}
                    <div>{result.message ?? "Erasure attempted."}</div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
              <button className="btn btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleErase} disabled={busy}>
                {busy ? "Erasing..." : "Erase credentials"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
