import type { Metadata } from "next";
import Link from "next/link";
import {
  IconArrowRight,
  IconShieldLock,
  IconFingerprint,
  IconCloudUpload,
  IconBolt,
  IconCode,
  IconUserCheck,
  IconRouteSquare,
} from "@tabler/icons-react";
import { CredentialCard } from "@/components/CredentialCard";

export const metadata: Metadata = {
  title: "StellarCred — Prove anything. Reveal nothing.",
  description:
    "Zero-knowledge credentials on Stellar. Prove facts about yourself without the underlying data ever touching the chain.",
  openGraph: {
    title: "StellarCred — Prove anything. Reveal nothing.",
    description:
      "Zero-knowledge credentials on Stellar. Prove facts about yourself without the underlying data ever touching the chain.",
    siteName: "StellarCred",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "StellarCred — Prove anything. Reveal nothing.",
    description:
      "Zero-knowledge credentials on Stellar. Prove facts about yourself without the underlying data ever touching the chain.",
  },
};

const ECOSYSTEM = ["LendFi", "StellarSwap", "PayrollX", "RWA Market", "TreasuryHub"];

function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      style={{
        fontFamily: "var(--font-mono), monospace",
        fontSize: "0.8rem",
        background: "var(--bg-raised)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "1rem 1.25rem",
        overflowX: "auto",
        lineHeight: 1.7,
        color: "var(--muted)",
        margin: 0,
        whiteSpace: "pre",
      }}
    >
      <code style={{ color: "var(--text)" }}>{children}</code>
    </pre>
  );
}

const STEPS = [
  {
    n: "01",
    icon: <IconFingerprint size={20} stroke={1.5} color="var(--accent)" />,
    title: "Issue",
    body: "A trusted issuer signs a credential to your wallet. It lives on your device — never on a server.",
  },
  {
    n: "02",
    icon: <IconBolt size={20} stroke={1.5} color="var(--accent)" />,
    title: "Prove",
    body: "Generate a zero-knowledge proof locally in your browser. Only the claim leaves; the data behind it never does.",
  },
  {
    n: "03",
    icon: <IconCloudUpload size={20} stroke={1.5} color="var(--accent)" />,
    title: "Verify",
    body: "Any Stellar protocol reads ProofRegistry on-chain. One proof, valid across every protocol, for 30 days.",
  },
];

const STATS = [
  { value: "4",        label: "Credential types" },
  { value: "UltraHonk", label: "ZK proof system" },
  { value: "~10s",    label: "Proof generation" },
  { value: "30 days", label: "Proof validity" },
];

export default function Home() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section
        className="reveal"
        style={{ paddingTop: "3rem" }}
      >
        {/* eyebrow chip */}
        <div style={{ marginBottom: "2rem" }}>
          <span
            className="eyebrow row"
            style={{
              display: "inline-flex",
              fontSize: "0.6rem",
              gap: "0.45rem",
              padding: "0.35rem 0.75rem",
              background: "rgba(62,207,142,0.07)",
              border: "1px solid rgba(62,207,142,0.2)",
              borderRadius: "999px",
              color: "var(--accent)",
            }}
          >
            <IconShieldLock size={13} stroke={2} />
            Zero-knowledge credentials · Stellar testnet
          </span>
        </div>

        <div
          className="grid grid-2"
          style={{ alignItems: "center", gap: "4rem" }}
        >
          {/* left: copy */}
          <div>
            <h1 style={{ marginBottom: "1.25rem" }}>
              Prove anything.{" "}
              <span className="gradient-text">Reveal&nbsp;nothing.</span>
            </h1>

            <p className="lead" style={{ maxWidth: 480, marginBottom: "2rem" }}>
              Hold a credential from a trusted issuer, generate an UltraHonk
              zero-knowledge proof locally, and verify your claim on Stellar —
              without the underlying data ever touching the chain.
            </p>

            <div className="row" style={{ gap: "0.65rem", flexWrap: "wrap" }}>
              <Link href="/apps" className="btn btn-primary btn-lg">
                See the demo
                <IconArrowRight size={16} />
              </Link>
              <Link href="/verify" className="btn btn-secondary btn-lg">
                Get a credential
              </Link>
            </div>
          </div>

          {/* right: credential card */}
          <div style={{ display: "flex", justifyContent: "right" }}>
            <CredentialCard
              issuer="StellarCred Authority"
              type="Identity Credential"
              holder="GA7X…K3NP"
              fields={[
                { label: "KYC status",   value: "verified" },
                { label: "Age",          value: null },
                { label: "Country",      value: null },
                { label: "Income range", value: null },
              ]}
              proofHash="0x4a3f8b2c00d9e1"
              validity="valid 30 days"
            />
          </div>
        </div>

        {/* stats strip */}
        <div className="stats-strip reveal" style={{ marginTop: "3.5rem" }}>
          {STATS.map((s, i) => (
            <div key={s.label} style={{ display: "contents" }}>
              <div className="stat-item">
                <span className="stat-value gradient-text">{s.value}</span>
                <span className="stat-label">{s.label}</span>
              </div>
              {i < STATS.length - 1 && <div className="stat-divider" />}
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section style={{ marginTop: "8rem" }}>
        <div style={{ marginBottom: "2.5rem" }}>
          <p className="eyebrow" style={{ marginBottom: "0.75rem" }}>Protocol</p>
          <h2>How StellarCred works</h2>
        </div>

        <div className="grid grid-3" style={{ gap: "1.25rem" }}>
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="card card-link"
              style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
            >
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: "var(--radius-sm)",
                  background: "rgba(62,207,142,0.08)",
                  border: "1px solid rgba(62,207,142,0.18)",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                {s.icon}
              </div>
              <div>
                <p className="feature-num">{s.n}</p>
                <h3 style={{ marginBottom: "0.5rem" }}>{s.title}</h3>
                <p className="muted" style={{ fontSize: "0.9rem", lineHeight: 1.65 }}>
                  {s.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Verified once. Trusted everywhere. ───────────────────────── */}
      <section style={{ marginTop: "8rem" }}>
        <div style={{ marginBottom: "2rem" }}>
          <p className="eyebrow" style={{ marginBottom: "0.75rem" }}>Infrastructure</p>
          <h2>Verified once. Trusted everywhere.</h2>
          <p className="lead" style={{ fontSize: "1rem", marginTop: "0.5rem" }}>
            Any protocol on Stellar can verify your credentials in one contract
            call. No API. No backend. No re-verification.
          </p>
        </div>

        <CodeBlock>{`// Any Stellar protocol
import { StellarCred } from "@stellarcred/sdk";

const canDeposit = await StellarCred.hasClaim(wallet, "kyc");`}</CodeBlock>

        <div
          className="row"
          style={{ gap: "0.6rem", flexWrap: "wrap", marginTop: "1.75rem" }}
        >
          {ECOSYSTEM.map((name) => (
            <span
              key={name}
              style={{
                padding: "0.45rem 0.9rem",
                borderRadius: "999px",
                border: "1px solid var(--border)",
                background: "rgba(255,255,255,0.02)",
                fontSize: "0.8125rem",
                color: "var(--muted)",
              }}
            >
              {name}
            </span>
          ))}
        </div>
      </section>

      {/* ── Two ways to get verified ─────────────────────────────────── */}
      <section style={{ marginTop: "8rem" }}>
        <div style={{ marginBottom: "2.5rem" }}>
          <p className="eyebrow" style={{ marginBottom: "0.75rem" }}>Flows</p>
          <h2>Two ways to get verified</h2>
        </div>

        <div className="grid grid-2" style={{ gap: "1.25rem" }}>
          {/* Verify directly */}
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: "var(--radius-sm)",
                background: "rgba(62,207,142,0.08)",
                border: "1px solid rgba(62,207,142,0.18)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <IconUserCheck size={20} stroke={1.5} color="var(--accent)" />
            </div>
            <div>
              <h3 style={{ marginBottom: "0.5rem" }}>Verify directly</h3>
              <p className="muted" style={{ fontSize: "0.9rem", lineHeight: 1.65 }}>
                Visit StellarCred before using any app. Your credentials work
                everywhere, instantly.
              </p>
            </div>
            <Link href="/verify" className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }}>
              Get verified
              <IconArrowRight size={14} />
            </Link>
          </div>

          {/* Verify through an app */}
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: "var(--radius-sm)",
                background: "rgba(62,207,142,0.08)",
                border: "1px solid rgba(62,207,142,0.18)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <IconRouteSquare size={20} stroke={1.5} color="var(--accent)" />
            </div>
            <div>
              <h3 style={{ marginBottom: "0.5rem" }}>Verify through an app</h3>
              <p className="muted" style={{ fontSize: "0.9rem", lineHeight: 1.65 }}>
                Apps that integrate StellarCred show a &ldquo;Verify&rdquo; button.
                Complete verification and return automatically.
              </p>
            </div>
            <div
              className="row mono"
              style={{
                gap: "0.5rem",
                fontSize: "0.8rem",
                color: "var(--muted)",
                flexWrap: "wrap",
              }}
            >
              <span>LendFi</span>
              <IconArrowRight size={13} color="var(--faint)" />
              <span style={{ color: "var(--accent)" }}>StellarCred</span>
              <IconArrowRight size={13} color="var(--faint)" />
              <span>LendFi</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Built for developers ─────────────────────────────────────── */}
      <section style={{ marginTop: "8rem" }}>
        <div style={{ marginBottom: "2.5rem" }}>
          <p className="eyebrow row" style={{ marginBottom: "0.75rem", gap: "0.4rem" }}>
            <IconCode size={13} stroke={2} /> Developers
          </p>
          <h2>Built for developers</h2>
        </div>

        <div className="grid grid-3" style={{ gap: "1.25rem" }}>
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <p className="feature-num">01</p>
            <h3 style={{ fontSize: "1rem" }}>Require a claim</h3>
            <CodeBlock>{`stellarcred.hasClaim(
  wallet, 'kyc'
)`}</CodeBlock>
          </div>
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <p className="feature-num">02</p>
            <h3 style={{ fontSize: "1rem" }}>Redirect if needed</h3>
            <CodeBlock>{`StellarCred.buildVerifyUrl({
  returnUrl,
  claim: 'kyc'
})`}</CodeBlock>
          </div>
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <p className="feature-num">03</p>
            <h3 style={{ fontSize: "1rem" }}>User returns verified</h3>
            <p className="muted" style={{ fontSize: "0.875rem", lineHeight: 1.65 }}>
              On-chain proof, read in one call. No backend needed.
            </p>
          </div>
        </div>

        <div style={{ marginTop: "1.75rem" }}>
          <Link href="/developers" className="btn btn-secondary btn-sm">
            Read the developer docs
            <IconArrowRight size={14} />
          </Link>
        </div>
      </section>

      {/* ── CTA strip ────────────────────────────────────────────────── */}
      <section style={{ marginTop: "8rem" }}>
        <div
          style={{
            padding: "3rem",
            borderRadius: "var(--radius-xl)",
            background: "linear-gradient(135deg, rgba(62,207,142,0.06) 0%, rgba(62,207,142,0.02) 100%)",
            border: "1px solid rgba(62,207,142,0.15)",
            textAlign: "center",
          }}
        >
          <h2 style={{ marginBottom: "0.75rem" }}>Ready to try it?</h2>
          <p
            className="muted"
            style={{ marginBottom: "2rem", maxWidth: 440, margin: "0 auto 2rem" }}
          >
            Connect a Stellar wallet on testnet, get a credential, generate
            your first on-chain ZK proof in under a minute.
          </p>
          <div className="row" style={{ justifyContent: "center", gap: "0.65rem", flexWrap: "wrap" }}>
            <Link href="/verify" className="btn btn-primary btn-lg">
              Get started
              <IconArrowRight size={16} />
            </Link>
            <Link href="/holder" className="btn btn-secondary btn-lg">
              Open dashboard
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
