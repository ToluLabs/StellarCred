"use client";

import { useState } from "react";
import { parseCredential, type Credential } from "@/lib/credential";
import {
  validateImportPayload,
  BUNDLE_FORMAT_VERSION,
} from "@/lib/credential-import-bounds";

/**
 * Verifies an exported credential file before it is applied.
 *
 * Accepted formats:
 *  - Integrity bundle `{ version, payload, checksum }` where `checksum` is the
 *    hex SHA-256 of the canonical JSON of `payload`. Checked before parsing.
 *  - Legacy bare credential JSON, accepted with a console warning because it
 *    carries no integrity data.
 *
 * Every failure throws a user-facing error that says what went wrong and what
 * to do next. Corrupt, truncated, or tampered input never reaches parseCredential.
 */

type BundleEnvelope = {
  version: number;
  payload: unknown;
  checksum: string;
};

const HEX_SHA256 = /^[0-9a-f]{64}$/;

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Deterministic JSON: object keys sorted recursively so checksums are stable.
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonicalize((value as Record<string, unknown>)[k])
        )
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

export async function verifyBundle(raw: string): Promise<Credential> {
  // Size, depth, length, and JSON-validity bounds run first. These throw
  // actionable messages for malformed or oversized input.
  const parsed = validateImportPayload(raw) as unknown;

  // Bundles produced by the shared integrity envelope (`integrity` key) are
  // already checksum-verified by validateImportPayload and are not handled here.
  // The envelope below is the holder-facing format written by the export flow.
  let envelope: BundleEnvelope | null = null;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const candidate = parsed as Partial<BundleEnvelope>;
    if (typeof candidate.checksum === "string" && candidate.payload !== undefined) {
      envelope = candidate as BundleEnvelope;
    }
  }

  if (!envelope) {
    // Legacy bare credentials carry no integrity check. Accept them, but
    // callers should surface that the file is unverified.
    console.warn(
      "Imported a legacy credential without an integrity checksum. Re-export it to enable tamper detection."
    );
    return parseCredential(raw);
  }

  if (typeof envelope.version !== "number" || envelope.version > BUNDLE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported bundle version (${String(envelope.version)}). Update the app before importing this file.`
    );
  }

  const checksum = envelope.checksum.toLowerCase();
  if (!HEX_SHA256.test(checksum)) {
    throw new Error(
      "Bundle checksum is malformed. The file may be corrupted. Re-export it from the source and try again."
    );
  }

  const actual = await sha256Hex(canonicalize(envelope.payload));
  if (actual !== checksum) {
    throw new Error(
      "Integrity check failed: the file was modified or corrupted after export. Re-export it from the source and try again."
    );
  }

  try {
    return parseCredential(JSON.stringify(envelope.payload));
  } catch (e) {
    throw new Error(
      `The bundle is authentic but its credential data is invalid: ${(e as Error).message}`
    );
  }
}

export function ImportPanel({
  onImport,
  onCancel,
}: {
  onImport: (c: Credential) => void;
  onCancel: () => void;
}) {
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onAdd() {
    setError("");
    setBusy(true);
    try {
      const credential = await verifyBundle(json);
      onImport(credential);
    } catch (e) {
      setError((e as Error).message || "Import failed for an unknown reason.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card reveal">
      <span className="eyebrow">Import credential</span>
      <textarea
        rows={5}
        placeholder='{"version":1,"payload":{"type":"kyc","commitment":"0x..."},"checksum":"..."}'
        value={json}
        onChange={(e) => setJson(e.target.value)}
        style={{ marginTop: "0.75rem" }}
      />
      {error && (
        <p
          role="alert"
          style={{ color: "var(--danger)", fontSize: "0.8125rem", marginTop: "0.5rem" }}
        >
          {error}
        </p>
      )}
      <div className="row" style={{ marginTop: "1rem", gap: "0.6rem" }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={onAdd}
          disabled={!json.trim() || busy}
        >
          {busy ? "Verifying..." : "Add credential"}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
