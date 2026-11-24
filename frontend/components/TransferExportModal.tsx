"use client";

import { useState } from "react";
import { Modal } from "./Modal";
import { QrCodeModal } from "./QrCodeModal";
import { buildTransferUrl } from "@/lib/transfer";
import type { Credential } from "@/lib/credential";

const MIN_PASSPHRASE_LENGTH = 8;

export function TransferExportModal({ cred, onClose }: { cred: Credential; onClose: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState<string | null>(null);

  async function onGenerate() {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      return;
    }
    if (passphrase !== confirm) {
      setError("Passphrases don't match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setUrl(await buildTransferUrl(cred, passphrase, window.location.origin));
    } catch {
      setError("Couldn't create the transfer code.");
    } finally {
      setBusy(false);
    }
  }

  if (url) {
    return (
      <QrCodeModal
        title="Transfer credential"
        value={url}
        hint={`Scan on the other device, then enter the same passphrase to import. This code alone reveals nothing about "${cred.title}" — it's only useful with that passphrase.`}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal title="Transfer credential" onClose={onClose}>
      <p className="faint" style={{ fontSize: "0.8125rem", marginBottom: "1rem", lineHeight: 1.6 }}>
        Set a passphrase to encrypt <strong style={{ color: "var(--text)" }}>{cred.title}</strong> before
        it becomes a QR code. You&rsquo;ll enter the same passphrase on the other device to import it.
      </p>

      <label htmlFor="export-passphrase" className="field-label">Passphrase</label>
      <input
        id="export-passphrase"
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder={`At least ${MIN_PASSPHRASE_LENGTH} characters`}
        autoFocus
      />

      <label htmlFor="export-confirm-passphrase" className="field-label" style={{ marginTop: "0.75rem" }}>Confirm passphrase</label>
      <input
        id="export-confirm-passphrase"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onGenerate()}
      />

      {error && <p role="alert" style={{ color: "var(--danger)", fontSize: "0.8125rem", marginTop: "0.6rem" }}>{error}</p>}

      <button
        className="btn btn-primary"
        style={{ width: "100%", marginTop: "1rem" }}
        onClick={onGenerate}
        disabled={busy || !passphrase || !confirm}
      >
        {busy ? "Encrypting…" : "Generate QR code"}
      </button>
    </Modal>
  );
}
