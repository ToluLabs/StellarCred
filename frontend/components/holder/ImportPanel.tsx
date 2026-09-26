"use client";

import { useState } from "react";
import type { Credential } from "@/lib/credential";

export function ImportPanel({
  onImport,
  onCancel,
}: {
  onImport: (c: Credential) => void;
  onCancel: () => void;
}) {
  const [json, setJson] = useState("");
  const [error, setError] = useState("");

  function onAdd() {
    try {
      onImport(JSON.parse(json));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="card reveal">
      <span className="eyebrow">Import credential</span>
      <textarea
        rows={5}
        placeholder='{"type":"kyc","commitment":"0x...", ...}'
        value={json}
        onChange={(e) => setJson(e.target.value)}
        style={{ marginTop: "0.75rem" }}
      />
      {error && (
        <p style={{ color: "var(--danger)", fontSize: "0.8125rem", marginTop: "0.5rem" }}>
          {error}
        </p>
      )}
      <div className="row" style={{ marginTop: "1rem", gap: "0.6rem" }}>
        <button className="btn btn-primary btn-sm" onClick={onAdd} disabled={!json.trim()}>
          Add credential
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
