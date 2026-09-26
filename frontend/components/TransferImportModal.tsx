"use client";

import { useState } from "react";
import { Modal } from "./Modal";
import { decryptTransferPayload, DecryptionError } from "@/lib/transfer";
import type { Credential } from "@/lib/credential";

export function TransferImportModal({
  payload,
  onImported,
  onClose,
}: {
  payload: string;
  onImported: (c: Credential) => void;
  onClose: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit() {
    setBusy(true);
    setError("");
    try {
      onImported(await decryptTransferPayload(payload, passphrase));
    } catch (e) {
      setError(e instanceof DecryptionError ? e.message : "Couldn't import this credential.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Import credential" onClose={onClose}>
      <p className="faint" style={{ fontSize: "0.8125rem", marginBottom: "1rem", lineHeight: 1.6 }}>
        Enter the passphrase used to encrypt this transfer code.
      </p>

      <label htmlFor="import-passphrase" className="field-label">Passphrase</label>
      <input
        id="import-passphrase"
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && passphrase && onSubmit()}
        autoFocus
      />

      {error && <p role="alert" style={{ color: "var(--danger)", fontSize: "0.8125rem", marginTop: "0.6rem" }}>{error}</p>}

      <button
        className="btn btn-primary"
        style={{ width: "100%", marginTop: "1rem" }}
        onClick={onSubmit}
        disabled={busy || !passphrase}
      >
        {busy ? "Decrypting…" : "Import"}
      </button>
    </Modal>
  );
}
