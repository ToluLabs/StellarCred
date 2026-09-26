"use client";

import { IconStack2 } from "@tabler/icons-react";
import { MAX_BATCH_SIZE } from "@/lib/contracts";
import { proofSubmissionConfigured } from "@/lib/config";

export function BatchBar({
  selectedCount,
  atBatchLimit,
  canSubmitBatch,
  onProveBatch,
  onClear,
  onSelectEligible,
}: {
  selectedCount: number;
  atBatchLimit: boolean;
  canSubmitBatch: boolean;
  onProveBatch: () => void;
  onClear: () => void;
  onSelectEligible: () => void;
}) {
  return (
    <div
      className="between"
      style={{
        alignItems: "center",
        gap: "0.75rem",
        flexWrap: "wrap",
        marginTop: "0.25rem",
      }}
    >
      <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
        <button
          id="prove-all-btn"
          className="btn btn-primary"
          style={{ gap: "0.45rem", display: "inline-flex", alignItems: "center" }}
          disabled={!canSubmitBatch || !proofSubmissionConfigured()}
          title={
            !proofSubmissionConfigured()
              ? "App not configured — NEXT_PUBLIC_PROOF_REGISTRY_ID missing"
              : canSubmitBatch
                ? undefined
                : "Select at least 2 credentials to prove them together"
          }
          onClick={onProveBatch}
        >
          <IconStack2 size={15} />
          {selectedCount > 0
            ? `Prove ${selectedCount} selected in one transaction`
            : "Prove several in one transaction"}
        </button>
        {selectedCount > 0 ? (
          <button className="btn btn-ghost btn-sm" onClick={onClear}>
            Clear
          </button>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={onSelectEligible}>
            Select eligible
          </button>
        )}
      </div>
      <span className="faint" style={{ fontSize: "0.75rem" }}>
        {atBatchLimit
          ? `Batch full — ${MAX_BATCH_SIZE} of ${MAX_BATCH_SIZE} selected.`
          : selectedCount === 0
            ? `Select up to ${MAX_BATCH_SIZE} credentials, one per credential type.`
            : `${selectedCount} of ${MAX_BATCH_SIZE} selected \u00b7 one per credential type.`}
      </span>
    </div>
  );
}
