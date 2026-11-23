"use client";

import { useRef } from "react";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";

/**
 * ConfirmRemoveModal — simple destructive-action confirmation dialog used by
 * HolderPageClient for bulk credential removal.
 *
 * Exposed as an alertdialog (it interrupts to confirm a destructive action):
 * focus lands on Cancel, Tab stays inside, Escape cancels, and focus returns
 * to the control that opened it.
 */
export function ConfirmRemoveModal({
  count,
  label,
  onConfirm,
  onCancel,
}: {
  count: number;
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, { onEscape: onCancel, initialFocusRef: cancelRef });

  return (
    <div
      className="modal-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-remove-title"
        aria-describedby="confirm-remove-desc"
        tabIndex={-1}
        className="modal-card"
        style={{
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "12px",
          padding: "1.5rem",
          maxWidth: "420px",
          width: "90%",
        }}
      >
        <h2 id="confirm-remove-title" style={{ marginTop: 0, fontSize: "1.2rem" }}>
          {label}
        </h2>
        <p id="confirm-remove-desc" className="faint" style={{ fontSize: "0.9rem", margin: "1rem 0" }}>
          This will permanently remove {count} credential{count > 1 ? "s" : ""} from
          your browser&apos;s local storage.
        </p>
        <div className="row" style={{ justifyContent: "flex-end", gap: "0.75rem" }}>
          <button ref={cancelRef} className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            style={{ backgroundColor: "#dc2626", color: "#fff" }}
            onClick={onConfirm}
          >
            Confirm Delete
          </button>
        </div>
      </div>
    </div>
  );
}
