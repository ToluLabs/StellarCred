import type { Metadata } from "next";
import { CONTRACTS } from "@/lib/stellar";
import dynamic from "next/dynamic";
import CopyButton from "@/components/CopyButton";

const SDKPlayground = dynamic(() => import("@/components/SDKPlayground"), {
  ssr: false,
  loading: () => (
    <div style={{ padding: "2rem 0", color: "var(--muted)", textAlign: "center" }}>
      Loading playground…
    </div>
  ),
});

export const metadata: Metadata = {
  title: "StellarCred — Developers",
  description: "Integrate StellarCred in minutes — one contract call, no backend.",
};

function Code({ children }: { children: string }) {
  const lines = children.split("\n");
  return (
    <pre
      style={{
        fontFamily: "var(--font-mono), monospace",
        fontSize: "0.8rem",
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "1rem 1.25rem",
        overflowX: "auto",
        lineHeight: 1.7,
        margin: "0.75rem 0 0",
        whiteSpace: "pre",
      }}
    >
      <code>
        {lines.map((line, i) => (
          <span key={i}>
            <span style={{ color: line.trimStart().startsWith("//") ? "var(--faint)" : "var(--accent)" }}>
              {line}
            </span>
            {i < lines.length - 1 ? "\n" : null}
          </span>
        ))}
      </code>
    </pre>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: "3rem" }}>
      <h2 style={{ fontSize: "1.25rem", marginBottom: "0.5rem", color: "var(--text)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

const CLAIMS: [string, string, string][] = [
  ["kyc", "Identity verified", "KYC provider"],
  ["age", "Age ≥ 18 (threshold configurable)", "KYC provider"],
  ["income", "Income ≥ threshold", "Financial data provider"],
  ["jurisdiction", "Country not restricted", "KYC provider"],
  ["funds", "Balance ≥ threshold", "Plaid / bank attestation"],
  ["accreditation", "Net worth ≥ threshold", "Financial institution"],
];

const ADDRESSES: [string, string][] = [
  ["NEXT_PUBLIC_ISSUER_REGISTRY_ID", CONTRACTS.issuerRegistry],
  ["NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID", CONTRACTS.credentialVerifier],
  ["NEXT_PUBLIC_PROOF_REGISTRY_ID", CONTRACTS.proofRegistry],
  ["NEXT_PUBLIC_GATED_POOL_ID", CONTRACTS.gatedPool],
];

export default function DevelopersPage() {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <span className="eyebrow">Developers</span>
      <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>Integrate StellarCred</h1>
      {/* <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.95rem", lineHeight: 1.6 }}>
        One contract call. No API keys. No data handling.{" "}
        <span style={{ color: "var(--accent)" }}>Verify once, trusted everywhere.</span>
      </p> */}

      <Section title="How it works">
        <p className="muted" style={{ fontSize: "0.95rem", lineHeight: 1.7 }}>
          StellarCred stores zero-knowledge proofs on Stellar. Your protocol
          reads them with one contract call. No API keys, no backend, no data
          handling — the only thing you trust is the on-chain{" "}
          <span className="mono">ProofRegistry</span>.
        </p>
      </Section>

      <Section title="Installation">
        <Code>{`npm install @stellarcred/sdk`}</Code>
      </Section>

      <Section title="Checking a claim">
        <p className="muted" style={{ fontSize: "0.95rem", lineHeight: 1.7 }}>
          The primary call. Returns <span className="mono">true</span> if the
          wallet has a valid, unexpired proof of the claim. For parameterised
          claims (age, income, funds), pass <span className="mono">minThreshold</span> to
          enforce the threshold on-chain — trustlessly.
        </p>
        <Code>{`import { StellarCred } from "@stellarcred/sdk";

// Binary claim (kyc, jurisdiction) — no threshold
const kycOk = await StellarCred.hasClaim(wallet, "kyc");

// Age gate — proof must have been generated with threshold_years >= 21
const ageOk = await StellarCred.hasClaim(wallet, "age", { minThreshold: 21 });

// Funds gate — proof must certify balance >= $50,000
const fundsOk = await StellarCred.hasClaim(wallet, "funds", { minThreshold: 50000 });`}</Code>
      </Section>

      <Section title="Fetching all claims">
        <p className="muted" style={{ fontSize: "0.95rem", lineHeight: 1.7 }}>
          Protocols that gate on multiple claims simultaneously benefit from fetching everything at once rather than making N separate <span className="mono">hasClaim</span> calls.
        </p>
        <Code>{`import { StellarCred } from "@stellarcred/sdk";

const claims = await StellarCred.getClaims(wallet);
// {
//   kyc:          { verified: true,  expiry: 1780000000 },
//   age:          { verified: true,  threshold: 21, expiry: 1780000000 },
//   income:       { verified: false },
//   jurisdiction: { verified: true,  expiry: 1780000000 },
//   funds:        { verified: false },
// }

// Gate on multiple claims at once
const canAccess = claims.kyc.verified && claims.age.verified;`}</Code>
      </Section>

      <Section title="Configuration">
        <p className="muted" style={{ fontSize: "0.95rem", lineHeight: 1.7 }}>
          Call <span className="mono">configure()</span> once at startup, or set env vars.
          Both approaches work in Node.js, Next.js, and edge runtimes.
        </p>
        <Code>{`import { StellarCred } from "@stellarcred/sdk";

// Option A — explicit (recommended for servers / edge)
StellarCred.configure({
  registryId: process.env.PROOF_REGISTRY_ID,
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
});

// Option B — env vars (auto-read at import time)
// STELLARCRED_REGISTRY_ID=C...
// STELLARCRED_RPC_URL=https://soroban-testnet.stellar.org
// (also reads NEXT_PUBLIC_PROOF_REGISTRY_ID / NEXT_PUBLIC_RPC_URL)`}</Code>
        <p className="muted" style={{ fontSize: "0.95rem", lineHeight: 1.7, marginTop: "1rem" }}>
          A missing <span className="mono">registryId</span> doesn&rsquo;t throw &mdash;
          it makes every <span className="mono">hasClaim</span>/
          <span className="mono">getClaims</span> call silently return{" "}
          <span className="mono">false</span>/<span className="mono">[]</span>, which can
          look like &ldquo;nobody is verified&rdquo; instead of &ldquo;misconfigured.&rdquo;
          Use <span className="mono">healthCheck()</span> to diagnose it directly (a dev-only
          console warning also fires automatically the first time this happens).
        </p>
        <Code>{`const health = StellarCred.healthCheck();
// { configured: false, registryId: false, rpcUrl: true, networkPassphrase: true,
//   missing: ["registryId"] }
if (!health.configured) console.error("StellarCred misconfigured:", health.missing);

// Or just: StellarCred.isConfigured() // boolean`}</Code>
      </Section>

      <Section title="Redirecting users to verify">
        <p className="muted" style={{ fontSize: "0.95rem", lineHeight: 1.7 }}>
          If a user hasn&rsquo;t verified yet, send them to StellarCred and get
          them back automatically. Use <span className="mono">claimParams</span> to
          customise thresholds.
        </p>
        <Code>{`import { StellarCred } from "@stellarcred/sdk";

// KYC gate — basic redirect
const kycUrl = StellarCred.buildVerifyUrl({
  returnUrl: 'https://yourapp.xyz/deposit',
  claim: 'kyc',
});

// Age gate — require 21+
const ageUrl = StellarCred.buildVerifyUrl({
  returnUrl: 'https://yourapp.xyz/markets',
  claim: 'age',
  claimParams: { threshold_years: '21' },
});

// Funds gate — require balance ≥ $50,000
const fundsUrl = StellarCred.buildVerifyUrl({
  returnUrl: 'https://yourapp.xyz/vault',
  claim: 'funds',
  claimParams: { threshold: '50000' },
});

// The return URL includes sc_verified=true, sc_wallet=<address>, and sc_claims=<types>
// sc_claims contains only the claim types issued in the current session.
const verified = await StellarCred.hasClaim(wallet, "kyc");`}</Code>
        <p className="muted" style={{ fontSize: "0.95rem", lineHeight: 1.7, marginTop: "1rem" }}>
          <strong>The return URL params are untrusted hints, not a proof.</strong>{" "}
          Nothing binds this redirect to your session &mdash; anyone can craft a
          URL shaped exactly like a real one and open it. Use{" "}
          <span className="mono">parseReturnParams</span> to read them, but
          always re-verify with <span className="mono">hasClaim</span> against
          the on-chain ProofRegistry (ideally server-side) before granting
          access.
        </p>
        <Code>{`import { StellarCred } from "@stellarcred/sdk";

// On your return page:
const hint = StellarCred.parseReturnParams(window.location.href);
// hint: { verified, wallet, claims, state } — all untrusted

if (hint.verified && hint.wallet) {
  // Optimistic UI only. The real gate is this on-chain check:
  const reallyVerified = await StellarCred.hasClaim(hint.wallet, "kyc");
}

// Optional: pass a per-session token to correlate the redirect back to a
// session you started (still not a substitute for hasClaim):
const url = StellarCred.buildVerifyUrl({
  returnUrl: "https://yourapp.xyz/deposit",
  claim: "kyc",
  state: sessionNonce,
});
// ...later, on the return page:
if (hint.state !== expectedSessionNonce) {
  // redirect doesn't correlate to a session you started — treat as untrusted
}`}</Code>
      </Section>

      <Section title="Available claim types">
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: "0.75rem",
            fontFamily: "var(--font-mono), monospace",
            fontSize: "0.8rem",
          }}
        >
          <thead>
            <tr>
              {["Claim", "What it proves", "Issued by"].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: "left",
                    padding: "0.6rem 0.75rem",
                    borderBottom: "1px solid var(--border)",
                    color: "var(--faint)",
                    fontWeight: 600,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CLAIMS.map(([claim, proves, by]) => (
              <tr key={claim}>
                <td style={{ padding: "0.6rem 0.75rem", borderBottom: "1px solid var(--border)", color: "var(--accent)" }}>
                  {claim}
                </td>
                <td style={{ padding: "0.6rem 0.75rem", borderBottom: "1px solid var(--border)", color: "var(--muted)" }}>
                  {proves}
                </td>
                <td style={{ padding: "0.6rem 0.75rem", borderBottom: "1px solid var(--border)", color: "var(--muted)" }}>
                  {by}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Contract addresses">
        <p className="muted" style={{ fontSize: "0.95rem", lineHeight: 1.7 }}>
          The deployed StellarCred contracts on{" "}
          <span className="mono">{process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet"}</span>.
        </p>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: "0.75rem",
            fontFamily: "var(--font-mono), monospace",
            fontSize: "0.78rem",
          }}
        >
          <tbody>
            {ADDRESSES.map(([name, value]) => (
              <tr key={name}>
                <td style={{ padding: "0.6rem 0.75rem", borderBottom: "1px solid var(--border)", color: "var(--faint)", whiteSpace: "nowrap" }}>
                  {name}
                </td>
                <td style={{ padding: "0.6rem 0.75rem", borderBottom: "1px solid var(--border)", color: "var(--muted)", wordBreak: "break-all" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span>{value || "— not configured —"}</span>
                    {value && <CopyButton value={value} />}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Calling the contract directly">
        <p className="muted" style={{ fontSize: "0.95rem", lineHeight: 1.7 }}>
          Prefer Soroban? Call ProofRegistry from your own contract — no SDK
          required. Use <span className="mono">is_verified</span> for binary claims
          and <span className="mono">check_claim</span> for threshold enforcement.
          Both take a trailing <span className="mono">trusted_issuers</span>{" "}
          parameter — pass <span className="mono">None</span> to accept a proof
          from any registered issuer (unchanged default), or{" "}
          <span className="mono">Some(vec![...])</span> to restrict a claim to
          specific issuers, e.g. accepting KYC only from Persona or Jumio.
        </p>
        <Code>{`// Binary claim (kyc, jurisdiction) — any registered issuer accepted
let registry = ProofRegistryClient::new(&env, &registry_id);
let (verified, _, _) = registry.is_verified(&holder, &symbol_short!("kyc"), &None);
require!(verified, Error::KycRequired);

// Parameterised claim — enforce minimum threshold on-chain
let eligible = registry.check_claim(&holder, &symbol_short!("funds"), &Some(50_000u64), &None);
require!(eligible, Error::InsufficientFunds);

// Restrict which issuer(s) a claim must come from
let trusted = vec![&env, persona_issuer.clone(), jumio_issuer.clone()];
let kyc_ok = registry.check_claim(&holder, &symbol_short!("kyc"), &None, &Some(trusted));
require!(kyc_ok, Error::KycRequired);`}</Code>
      </Section>

      <SDKPlayground />

      <div style={{ height: "4rem" }} />
    </div>
  );
}
