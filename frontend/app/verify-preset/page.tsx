"use client";

// Consumption side of a selective disclosure preset (#386): a protocol opens
// the deep link a holder shared from /presets, supplies the wallet to check,
// and gets a single on-chain-backed pass/fail per claim plus an overall
// result — via the SDK's `verifyPreset`, which is just a batched `hasClaims`
// call, so this page is itself a reference implementation of the "protocol
// requests a preset and verifies it end to end" flow the issue asks for.

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { verifyPreset, type PresetVerificationResult } from "@stellarcred/sdk";
import { decodePresetClaims } from "@/lib/presets";
import { TYPE_META } from "@/lib/credential";

function VerifyPresetInner() {
  const params = useSearchParams();
  const name = params.get("name") ?? "Untitled preset";
  const claims = decodePresetClaims(params.get("c") ?? "");

  const [wallet, setWallet] = useState("");
  const [result, setResult] = useState<PresetVerificationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onVerify() {
    if (!wallet.trim() || claims.length === 0) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await verifyPreset(wallet.trim(), claims));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: "2rem" }}>
        <span className="eyebrow">Verify preset</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>{name}</h1>
      </div>

      {claims.length === 0 ? (
        <p className="faint">
          This link doesn&apos;t name any recognised claims — ask the holder
          for a fresh one.
        </p>
      ) : (
        <div className="card" style={{ maxWidth: 480 }}>
          <p className="faint" style={{ fontSize: "0.875rem", marginBottom: "1rem" }}>
            Checks {claims.length} claim{claims.length === 1 ? "" : "s"} against
            the on-chain ProofRegistry:{" "}
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
            <p style={{ marginTop: "0.75rem", fontSize: "0.8125rem", color: "var(--danger)" }}>
              {error}
            </p>
          )}

          {result && (
            <div style={{ marginTop: "1.25rem" }}>
              <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
                {result.allValid ? "✓ All claims verified" : "✗ Not all claims verified"}
              </p>
              <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.875rem" }}>
                {claims.map((c) => (
                  <li key={c.type}>
                    {TYPE_META[c.type].title}: {result.results[c.type] ? "verified" : "not verified"}
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

export default function VerifyPresetPage() {
  return (
    <Suspense fallback={null}>
      <VerifyPresetInner />
    </Suspense>
  );
}
