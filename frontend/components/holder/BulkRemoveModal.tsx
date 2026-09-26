"use client";

interface BulkRemoveModalProps {
  type: "remove-selected" | "clear-expired";
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function BulkRemoveModal({
  type,
  count,
  onCancel,
  onConfirm,
}: BulkRemoveModalProps) {
  return (
    <div
      className="modal-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
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
        <h3 style={{ marginTop: 0, fontSize: "1.2rem" }}>
          {type === "clear-expired"
            ? "Clear Expired Credentials?"
            : "Remove Selected Credentials?"}
        </h3>
        <p className="faint" style={{ fontSize: "0.9rem", margin: "1rem 0" }}>
          Are you sure you want to remove {count} credential{count > 1 ? "s" : ""}? This will permanently remove them
          from your browser&apos;s encrypted local storage.
        </p>
        <div className="row" style={{ justifyContent: "flex-end", gap: "0.75rem" }}>
          <button className="btn btn-secondary" onClick={onCancel}>
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
