"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  verifyPreset,
  type PresetVerificationResult,
} from "@stellarcred/sdk";
import { decodePresetClaims } from "@/lib/presets";
import { TYPE_META } from "@/lib/credential";
import { classifyRpcError, probeRpcHealth } from "@/lib/rpc-health";

function VerifyPresetInner() {
  const params = useSearchParams();
  const name = params.get("name") ?? "Untitled preset";
  const claims = decodePresetClaims(params.get("c") ?? "");

  const [wallet, setWallet] = useState("");
  const [result, setResult] =
    useState<PresetVerificationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /**
   * Set when the ledger could not be read at all (#634). Rendered as
   * "unknown" — the SDK resolves a per-claim read failure to `false`, which
   * on its own is indistinguishable from a genuine "not verified".
   */
  const [undetermined, setUndetermined] = useState<string | null>(null);

  async function onVerify() {
    if (!wallet.trim() || claims.length === 0) return;
    setBusy(true);
    setError("");
    setUndetermined(null);
    setResult(null);
    try {
      // Reachability first: a doomed batch is reported as "not verified", so
      // an outage must be caught here to stay distinguishable from a rejection.
      const issue = await probeRpcHealth();
      if (issue) {
        setUndetermined(issue.message);
        return;
      }
      setResult(await verifyPreset(wallet.trim(), claims));
    } catch (e) {
      setUndetermined(classifyRpcError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: "2rem" }}>
        <span className="eyebrow">Verify preset</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>
          {name}
        </h1>
      </div>

      {claims.length === 0 ? (
        <p className="faint">
          This link doesn&apos;t name any recognised claims — ask the holder
          for a fresh one.
        </p>
      ) : (
        <div className="card" style={{ maxWidth: 480 }}>
          <p
            className="faint"
            style={{
              fontSize: "0.875rem",
              marginBottom: "1rem",
            }}
          >
            Checks {claims.length} claim
            {claims.length === 1 ? "" : "s"} against the on-chain
            ProofRegistry:{" "}
            {claims
              .map((c) =>
                c.minThreshold !== undefined
                  ? `${TYPE_META[c.type].title} (≥ ${c.minThreshold})`
                  : TYPE_META[c.type].title,
              )
              .join(", ")}
            .
          </p>

          <label className="field-label" htmlFor="verify-wallet">
            Wallet address
          </label>
          <input
            id="verify-wallet"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="G…"
          />

          <button
            className="btn btn-primary"
            style={{ marginTop: "1rem", width: "100%" }}
            disabled={busy || !wallet.trim()}
            onClick={onVerify}
          >
            {busy ? "Checking…" : "Verify"}
          </button>

          {error && (
            <p
              style={{
                marginTop: "0.75rem",
                fontSize: "0.8125rem",
                color: "var(--danger)",
              }}
            >
              {error}
            </p>
          )}

          {undetermined && (
            <div
              role="status"
              style={{
                marginTop: "1rem",
                padding: "0.85rem 1rem",
                borderRadius: "var(--radius)",
                border: "1px solid rgba(227,179,65,0.35)",
                background: "rgba(227,179,65,0.07)",
              }}
            >
              <p style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--warn)" }}>
                ? Status unknown
              </p>
              <p style={{ marginTop: "0.35rem", fontSize: "0.8125rem", lineHeight: 1.6 }}>
                {undetermined} The claims were not checked — this is not a
                result, and it is not a rejection. Try again once the network
                recovers.
              </p>
            </div>
          )}

          {result && (
            <div style={{ marginTop: "1.25rem" }}>
              <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
                {result.allValid
                  ? "✓ All claims verified"
                  : "✗ Not all claims verified"}
              </p>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: "1.25rem",
                  fontSize: "0.875rem",
                }}
              >
                {claims.map((c) => (
                  <li key={c.type}>
                    {TYPE_META[c.type].title}:{" "}
                    {result.results[c.type]
                      ? "verified"
                      : "not verified"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function VerifyPresetPageClient() {
  return (
    <Suspense fallback={null}>
      <VerifyPresetInner />
    </Suspense>
  );
}
