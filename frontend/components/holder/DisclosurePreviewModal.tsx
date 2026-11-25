"use client";

// Attribute disclosure preview (#1048).
//
// Shown when the holder clicks "Generate proof" (or "Prove selected"), before
// the prover starts. A side-by-side diff lists what the proof shares with the
// verifier, marked in green, against what stays private, marked with a lock.
// Nothing is computed or sent until the holder approves.

import { useMemo } from "react";
import { IconEye, IconLock, IconShieldCheck } from "@tabler/icons-react";
import { Modal } from "@/components/Modal";
import type { Credential } from "@/lib/credential";
import {
  buildDisclosureDiff,
  type DisclosureDiff,
  type DisclosureItem,
} from "@/lib/disclosure-diff";

export interface DisclosurePreviewModalProps {
  /** Credentials the holder is about to prove (one, or a batch). */
  creds: Credential[];
  /** Connected wallet that will submit the proof. */
  holder: string;
  /** Called when the holder approves; proof generation starts after this. */
  onApprove: () => void;
  /** Called on Cancel, Escape or a backdrop click; nothing is proved. */
  onCancel: () => void;
  /** Clock override for tests (age proofs disclose today's date). */
  now?: Date;
}

const columnStyle: React.CSSProperties = {
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  padding: "0.85rem 1rem",
  minWidth: 0,
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.6rem",
};

function SharedRow({ item }: { item: DisclosureItem }) {
  return (
    <li
      data-visibility="shared"
      style={{
        borderLeft: "3px solid var(--accent)",
        background: "var(--accent-soft)",
        borderRadius: "var(--radius-sm)",
        padding: "0.45rem 0.65rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "0.75rem",
          fontSize: "0.8125rem",
        }}
      >
        <span style={{ color: "var(--muted)" }}>{item.label}</span>
        <span
          style={{
            color: "var(--text)",
            textAlign: "right",
            wordBreak: "break-all",
          }}
        >
          {item.value}
        </span>
      </div>
      <p
        style={{
          margin: "0.2rem 0 0",
          fontSize: "0.75rem",
          color: "var(--faint)",
        }}
      >
        {item.detail}
      </p>
    </li>
  );
}

function PrivateRow({ item }: { item: DisclosureItem }) {
  return (
    <li
      data-visibility="private"
      style={{
        display: "flex",
        gap: "0.55rem",
        alignItems: "flex-start",
        borderRadius: "var(--radius-sm)",
        padding: "0.45rem 0.65rem",
        background: "rgba(255,255,255,0.025)",
      }}
    >
      <span
        data-testid="private-lock"
        aria-hidden="true"
        style={{ color: "var(--muted)", flexShrink: 0, marginTop: 1 }}
      >
        <IconLock size={14} />
      </span>
      <span>
        <span
          style={{
            display: "block",
            fontSize: "0.8125rem",
            color: "var(--text)",
          }}
        >
          {item.label}
        </span>
        <span
          style={{
            display: "block",
            fontSize: "0.75rem",
            color: "var(--faint)",
          }}
        >
          {item.detail}
        </span>
      </span>
    </li>
  );
}

function CredentialDiff({ diff }: { diff: DisclosureDiff }) {
  return (
    <div>
      <h3 style={{ fontSize: "0.95rem", margin: "0 0 0.6rem" }}>{diff.title}</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <section
          aria-label={`Shared publicly: ${diff.title}`}
          style={{ ...columnStyle, borderColor: "var(--accent)" }}
        >
          <h4
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              margin: "0 0 0.65rem",
              fontSize: "0.8125rem",
              color: "var(--accent)",
            }}
          >
            <IconEye size={15} aria-hidden="true" />
            Shared Publicly
          </h4>
          <ul style={listStyle}>
            {diff.shared.map((item) => (
              <SharedRow key={item.key} item={item} />
            ))}
          </ul>
        </section>
        <section aria-label={`Kept private: ${diff.title}`} style={columnStyle}>
          <h4
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              margin: "0 0 0.65rem",
              fontSize: "0.8125rem",
              color: "var(--muted)",
            }}
          >
            <IconLock size={15} aria-hidden="true" />
            Kept Private
          </h4>
          <ul style={listStyle}>
            {diff.kept.map((item) => (
              <PrivateRow key={item.key} item={item} />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

export function DisclosurePreviewModal({
  creds,
  holder,
  onApprove,
  onCancel,
  now,
}: DisclosurePreviewModalProps) {
  const diffs = useMemo(
    () => creds.map((cred) => buildDisclosureDiff(cred, { holder, now })),
    [creds, holder, now],
  );
  const count = diffs.length;

  return (
    <Modal
      id="disclosure-preview"
      title="Review what you'll share"
      onClose={onCancel}
      maxWidth="720px"
    >
      <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 10rem)" }}>
        <p
          style={{
            margin: "0 0 1rem",
            fontSize: "0.8125rem",
            color: "var(--muted)",
            lineHeight: 1.55,
          }}
        >
          The proof is generated in your browser. The verifier, and anyone reading the chain, sees
          only what is <strong style={{ color: "var(--accent)" }}>shared publicly</strong>.
          Everything marked <strong style={{ color: "var(--text)" }}>kept private</strong> is used
          inside the proof and never leaves this device.
        </p>
        <div className="stack" style={{ gap: "1.25rem" }}>
          {diffs.map((diff) => (
            <CredentialDiff key={diff.commitment} diff={diff} />
          ))}
        </div>
      </div>
      <div
        className="row"
        style={{
          gap: "0.75rem",
          marginTop: "1.25rem",
          justifyContent: "flex-end",
        }}
      >
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          style={{ gap: "0.5rem" }}
          onClick={onApprove}
          data-testid="approve-disclosure-btn"
        >
          <IconShieldCheck size={15} aria-hidden="true" />
          {count > 1 ? `Approve & generate ${count} proofs` : "Approve & generate proof"}
        </button>
      </div>
    </Modal>
  );
}
