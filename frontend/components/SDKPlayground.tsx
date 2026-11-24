"use client";

import { useState, useCallback } from "react";
import CopyButton from "./CopyButton";

type ClaimType = "kyc" | "age" | "income" | "jurisdiction" | "funds" | "accreditation";
type TabId = "hasClaim" | "getClaims" | "buildVerifyUrl" | "parseReturnParams";

const TABS: { id: TabId; label: string; description: string }[] = [
  { id: "hasClaim", label: "hasClaim", description: "Check if a wallet has a specific claim" },
  { id: "getClaims", label: "getClaims", description: "Fetch all claims for a wallet" },
  { id: "buildVerifyUrl", label: "buildVerifyUrl", description: "Generate a verification redirect URL" },
  { id: "parseReturnParams", label: "parseReturnParams", description: "Parse return URL query params" },
];

const CLAIM_TYPES: ClaimType[] = ["kyc", "age", "income", "jurisdiction", "funds", "accreditation"];

function CodeBlock({ children }: { children: string }) {
  return (
    <div style={{ position: "relative", fontFamily: "var(--font-mono), monospace", fontSize: "0.78rem", background: "var(--input)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0.75rem 1rem", overflowX: "auto", lineHeight: 1.7, whiteSpace: "pre" as const }}>
      <code style={{ color: "var(--accent)" }}>{children}</code>
      <div style={{ position: "absolute", top: "0.5rem", right: "0.5rem" }}><CopyButton value={children} /></div>
    </div>
  );
}

function ResultBox({ children, isError }: { children: React.ReactNode; isError?: boolean }) {
  return (
    <div style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.8rem", background: isError ? "rgba(240, 96, 77, 0.08)" : "rgba(62, 207, 142, 0.06)", border: "1px solid " + (isError ? "rgba(240, 96, 77, 0.2)" : "rgba(62, 207, 142, 0.15)"), borderRadius: "var(--radius-sm)", padding: "0.75rem 1rem", lineHeight: 1.6, color: isError ? "var(--danger)" : "var(--text)" }}>
      {children}
    </div>
  );
}

function InputField({ label, value, onChange, placeholder, mono }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column" as const, gap: "0.35rem" }}>
      <span style={{ fontSize: "0.8rem", color: "var(--muted)", fontWeight: 500 }}>{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        style={{ fontFamily: mono ? "var(--font-mono), monospace" : "inherit", fontSize: "0.85rem", background: "var(--input)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0.6rem 0.75rem", color: "var(--text)", outline: "none" }} />
    </label>
  );
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label style={{ display: "flex", flexDirection: "column" as const, gap: "0.35rem" }}>
      <span style={{ fontSize: "0.8rem", color: "var(--muted)", fontWeight: 500 }}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.85rem", background: "var(--input)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "0.6rem 0.75rem", color: "var(--text)", outline: "none", cursor: "pointer" }}>
        {options.map((opt) => (<option key={opt.value} value={opt.value}>{opt.label}</option>))}
      </select>
    </label>
  );
}

function RunButton({ onClick, loading, label }: { onClick: () => void; loading: boolean; label: string }) {
  return (
    <button onClick={onClick} disabled={loading}
      style={{ fontFamily: "var(--font-display), sans-serif", fontWeight: 600, fontSize: "0.85rem", background: loading ? "var(--accent-dim)" : "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: "var(--radius-sm)", padding: "0.6rem 1.25rem", cursor: loading ? "wait" : "pointer", opacity: loading ? 0.7 : 1 }}>
      {loading ? "Running..." : label}
    </button>
  );
}

function HasClaimDemo() {
  const [wallet, setWallet] = useState("");
  const [claimType, setClaimType] = useState<ClaimType>("kyc");
  const [threshold, setThreshold] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async () => {
    if (!wallet.trim()) return;
    setLoading(true); setResult(null); setError(null);
    try {
      const { StellarCred } = await import("@stellarcred/sdk");
      const t = threshold ? Number(threshold) : undefined;
      const ok = await StellarCred.hasClaim(wallet, claimType, t ? { minThreshold: t } : undefined);
      setResult(JSON.stringify(ok));
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "SDK call failed"); }
    finally { setLoading(false); }
  }, [wallet, claimType, threshold]);
  const code = threshold
    ? 'import { StellarCred } from "@stellarcred/sdk";\n\nconst ok = await StellarCred.hasClaim(\n  "' + wallet + '",\n  "' + claimType + '",\n  { minThreshold: ' + threshold + ' }\n);\n\n// => ' + (result ?? "...")
    : 'import { StellarCred } from "@stellarcred/sdk";\n\nconst ok = await StellarCred.hasClaim(\n  "' + wallet + '",\n  "' + claimType + '"\n);\n\n// => ' + (result ?? "...");
  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "1rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <div style={{ gridColumn: "1 / -1" }}><InputField label="Wallet address" value={wallet} onChange={setWallet} placeholder="GABCDEF..." mono /></div>
        <SelectField label="Claim type" value={claimType} onChange={(v) => setClaimType(v as ClaimType)} options={CLAIM_TYPES.map((t) => ({ value: t, label: t }))} />
        <InputField label="Min threshold (optional)" value={threshold} onChange={setThreshold} placeholder="e.g. 21" />
      </div>
      <RunButton onClick={run} loading={loading} label="Run hasClaim" />
      {result !== null && (<><ResultBox>Result: {result}</ResultBox><CodeBlock>{code}</CodeBlock></>)}
      {error && <ResultBox isError>Error: {error}</ResultBox>}
    </div>
  );
}

function GetClaimsDemo() {
  const [wallet, setWallet] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async () => {
    if (!wallet.trim()) return;
    setLoading(true); setResult(null); setError(null);
    try {
      const { StellarCred } = await import("@stellarcred/sdk");
      const claims = await StellarCred.getClaims(wallet);
      setResult(JSON.stringify(claims, null, 2));
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "SDK call failed"); }
    finally { setLoading(false); }
  }, [wallet]);
  const code = 'import { StellarCred } from "@stellarcred/sdk";\n\nconst claims = await StellarCred.getClaims(\n  "' + wallet + '"\n);\n\n// => ' + (result ?? "...");
  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "1rem" }}>
      <InputField label="Wallet address" value={wallet} onChange={setWallet} placeholder="GABCDEF..." mono />
      <RunButton onClick={run} loading={loading} label="Run getClaims" />
      {result !== null && (<><ResultBox>Result: {result}</ResultBox><CodeBlock>{code}</CodeBlock></>)}
      {error && <ResultBox isError>Error: {error}</ResultBox>}
    </div>
  );
}

function BuildVerifyUrlDemo() {
  const [returnUrl, setReturnUrl] = useState("https://yourapp.xyz/deposit");
  const [claimType, setClaimType] = useState<ClaimType>("kyc");
  const [thresholdYears, setThresholdYears] = useState("");
  const [threshold, setThreshold] = useState("");
  const [restricted, setRestricted] = useState("");
  const [state, setState] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generate = useCallback(async () => {
    try {
      const { StellarCred } = await import("@stellarcred/sdk");
      const cp: Record<string, string> = {};
      if (thresholdYears) cp.threshold_years = thresholdYears;
      if (threshold) cp.threshold = threshold;
      if (restricted) cp.restricted = restricted;
      const url = StellarCred.buildVerifyUrl({ returnUrl, claim: claimType, ...(Object.keys(cp).length > 0 ? { claimParams: cp } : {}), ...(state ? { state } : {}) });
      setResult(url); setError(null);
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "SDK call failed"); }
  }, [returnUrl, claimType, thresholdYears, threshold, restricted, state]);
  const lines = ['import { StellarCred } from "@stellarcred/sdk";', "", "const url = StellarCred.buildVerifyUrl({", '  returnUrl: "' + returnUrl + '",', '  claim: "' + claimType + '",'];
  if (thresholdYears) lines.push('  claimParams: { threshold_years: "' + thresholdYears + '" },');
  if (threshold) lines.push('  claimParams: { threshold: "' + threshold + '" },');
  if (restricted) lines.push('  claimParams: { restricted: "' + restricted + '" },');
  if (state) lines.push('  state: "' + state + '",');
  lines.push("});");
  if (result) lines.push("", "// => " + result);
  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "1rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <InputField label="Return URL" value={returnUrl} onChange={setReturnUrl} placeholder="https://yourapp.xyz/callback" />
        <SelectField label="Claim type" value={claimType} onChange={(v) => setClaimType(v as ClaimType)} options={CLAIM_TYPES.map((t) => ({ value: t, label: t }))} />
        <InputField label="Threshold years (age)" value={thresholdYears} onChange={setThresholdYears} placeholder="e.g. 21" />
        <InputField label="Threshold (income/funds)" value={threshold} onChange={setThreshold} placeholder="e.g. 50000" />
        <InputField label="Restricted countries" value={restricted} onChange={setRestricted} placeholder="e.g. 840,364" />
        <InputField label="State token" value={state} onChange={setState} placeholder="optional" />
      </div>
      <button onClick={generate} style={{ fontFamily: "var(--font-display), sans-serif", fontWeight: 600, fontSize: "0.85rem", background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: "var(--radius-sm)", padding: "0.6rem 1.25rem", cursor: "pointer", alignSelf: "flex-start" }}>Generate URL</button>
      {result !== null && (<><ResultBox><span style={{ color: "var(--faint)" }}>Generated URL: </span><span style={{ wordBreak: "break-all" }}>{result}</span></ResultBox><CodeBlock>{lines.join("\n")}</CodeBlock></>)}
      {error && <ResultBox isError>Error: {error}</ResultBox>}
    </div>
  );
}

function ParseReturnParamsDemo() {
  const [url, setUrl] = useState("https://yourapp.xyz/callback?sc_verified=true&sc_wallet=GABCDEF1234&sc_claims=kyc,age&sc_state=abc123");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parse = useCallback(async () => {
    try {
      const { StellarCred } = await import("@stellarcred/sdk");
      const hint = StellarCred.parseReturnParams(url);
      setResult(JSON.stringify(hint, null, 2)); setError(null);
    } catch (err: unknown) { setError(err instanceof Error ? err.message : "Parse failed"); }
  }, [url]);
  const code = 'import { StellarCred } from "@stellarcred/sdk";\n\nconst hint = StellarCred.parseReturnParams(\n  "' + url + '"\n);\n\n// => ' + (result ?? "...") + '\n\n// Always re-verify on-chain:\nif (hint.verified && hint.wallet) {\n  const ok = await StellarCred.hasClaim(hint.wallet, "kyc");\n}';
  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "1rem" }}>
      <InputField label="Return URL to parse" value={url} onChange={setUrl} placeholder="https://yourapp.xyz/callback?sc_verified=true..." />
      <button onClick={parse} style={{ fontFamily: "var(--font-display), sans-serif", fontWeight: 600, fontSize: "0.85rem", background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: "var(--radius-sm)", padding: "0.6rem 1.25rem", cursor: "pointer", alignSelf: "flex-start" }}>Parse URL</button>
      {result !== null && (<><ResultBox>Result: {result}</ResultBox><CodeBlock>{code}</CodeBlock></>)}
      {error && <ResultBox isError>Error: {error}</ResultBox>}
    </div>
  );
}

export default function SDKPlayground() {
  const [activeTab, setActiveTab] = useState<TabId>("hasClaim");
  return (
    <div style={{ marginTop: "3rem" }}>
      <h2 style={{ fontSize: "1.5rem", fontFamily: "var(--font-display), sans-serif", fontWeight: 700, marginBottom: "0.25rem" }}>Live SDK Playground</h2>
      <p style={{ fontSize: "0.95rem", lineHeight: 1.6, color: "var(--muted)", marginBottom: "1.5rem" }}>
        Try the SDK calls against testnet - enter a wallet, pick a claim, and see the result plus the exact code to copy into your app. Read-only, no keys required.
      </p>
      <div style={{ display: "flex", gap: "0.25rem", borderBottom: "1px solid var(--border)", marginBottom: "1.5rem", overflowX: "auto" }}>
        {TABS.map((tab) => (<button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.82rem", fontWeight: activeTab === tab.id ? 600 : 400, background: "none", border: "none", borderBottom: "2px solid " + (activeTab === tab.id ? "var(--accent)" : "transparent"), color: activeTab === tab.id ? "var(--accent)" : "var(--muted)", padding: "0.6rem 1rem", cursor: "pointer", whiteSpace: "nowrap" }}>{tab.label}</button>))}
      </div>
      <div style={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1.25rem" }}>
        <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginBottom: "1rem", lineHeight: 1.5 }}>{TABS.find((t) => t.id === activeTab)?.description}</p>
        {activeTab === "hasClaim" && <HasClaimDemo />}
        {activeTab === "getClaims" && <GetClaimsDemo />}
        {activeTab === "buildVerifyUrl" && <BuildVerifyUrlDemo />}
        {activeTab === "parseReturnParams" && <ParseReturnParamsDemo />}
      </div>
    </div>
  );
}
