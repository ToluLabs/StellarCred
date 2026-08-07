"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
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

const STATS_VALUES = [
  { value: "4",         key: "credentialTypes" },
  { value: "UltraHonk", key: "zkSystem" },
  { value: "~10s",      key: "proofGeneration" },
  { value: "30 days",   key: "proofValidity" },
] as const;

export default function Home() {
  const t = useTranslations("home");

  const STEPS = [
    {
      n: "01",
      icon: <IconFingerprint size={20} stroke={1.5} color="var(--accent)" />,
      title: t("steps.issue.title"),
      body: t("steps.issue.body"),
    },
    {
      n: "02",
      icon: <IconBolt size={20} stroke={1.5} color="var(--accent)" />,
      title: t("steps.prove.title"),
      body: t("steps.prove.body"),
    },
    {
      n: "03",
      icon: <IconCloudUpload size={20} stroke={1.5} color="var(--accent)" />,
      title: t("steps.verifyStep.title"),
      body: t("steps.verifyStep.body"),
    },
  ];

  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="reveal" style={{ paddingTop: "3rem" }}>
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
            {t("eyebrow")}
          </span>
        </div>

        <div className="grid grid-2" style={{ alignItems: "center", gap: "4rem" }}>
          <div>
            <h1 style={{ marginBottom: "1.25rem" }}>
              {t("headline1")}{" "}
              <span className="gradient-text">{t("headline2")}</span>
            </h1>

            <p className="lead" style={{ maxWidth: 480, marginBottom: "2rem" }}>
              {t("lead")}
            </p>

            <div className="row" style={{ gap: "0.65rem", flexWrap: "wrap" }}>
              <Link href="/apps" className="btn btn-primary btn-lg">
                {t("cta_demo")}
                <IconArrowRight size={16} />
              </Link>
              <Link href="/verify" className="btn btn-secondary btn-lg">
                {t("cta_credential")}
              </Link>
            </div>
          </div>

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

        <div className="stats-strip reveal" style={{ marginTop: "3.5rem" }}>
          {STATS_VALUES.map((s, i) => (
            <div key={s.key} style={{ display: "contents" }}>
              <div className="stat-item">
                <span className="stat-value gradient-text">{s.value}</span>
                <span className="stat-label">{t(`stats.${s.key}`)}</span>
              </div>
              {i < STATS_VALUES.length - 1 && <div className="stat-divider" />}
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <section style={{ marginTop: "8rem" }}>
        <div style={{ marginBottom: "2.5rem" }}>
          <p className="eyebrow" style={{ marginBottom: "0.75rem" }}>{t("howItWorksEyebrow")}</p>
          <h2>{t("howItWorksTitle")}</h2>
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
                  width: 38, height: 38,
                  borderRadius: "var(--radius-sm)",
                  background: "rgba(62,207,142,0.08)",
                  border: "1px solid rgba(62,207,142,0.18)",
                  display: "grid", placeItems: "center", flexShrink: 0,
                }}
              >
                {s.icon}
              </div>
              <div>
                <p className="feature-num">{s.n}</p>
                <h3 style={{ marginBottom: "0.5rem" }}>{s.title}</h3>
                <p className="muted" style={{ fontSize: "0.9rem", lineHeight: 1.65 }}>{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Verified once. Trusted everywhere. ───────────────────────── */}
      <section style={{ marginTop: "8rem" }}>
        <div style={{ marginBottom: "2rem" }}>
          <p className="eyebrow" style={{ marginBottom: "0.75rem" }}>{t("trustedEyebrow")}</p>
          <h2>{t("trustedTitle")}</h2>
          <p className="lead" style={{ fontSize: "1rem", marginTop: "0.5rem" }}>
            {t("trustedLead")}
          </p>
        </div>

        <CodeBlock>{`// Any Stellar protocol
import { StellarCred } from "@stellarcred/sdk";

const canDeposit = await StellarCred.hasClaim(wallet, "kyc");`}</CodeBlock>

        <div className="row" style={{ gap: "0.6rem", flexWrap: "wrap", marginTop: "1.75rem" }}>
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
          <p className="eyebrow" style={{ marginBottom: "0.75rem" }}>{t("twoWaysEyebrow")}</p>
          <h2>{t("twoWaysTitle")}</h2>
        </div>

        <div className="grid grid-2" style={{ gap: "1.25rem" }}>
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div
              style={{
                width: 38, height: 38,
                borderRadius: "var(--radius-sm)",
                background: "rgba(62,207,142,0.08)",
                border: "1px solid rgba(62,207,142,0.18)",
                display: "grid", placeItems: "center",
              }}
            >
              <IconUserCheck size={20} stroke={1.5} color="var(--accent)" />
            </div>
            <div>
              <h3 style={{ marginBottom: "0.5rem" }}>{t("directTitle")}</h3>
              <p className="muted" style={{ fontSize: "0.9rem", lineHeight: 1.65 }}>{t("directBody")}</p>
            </div>
            <Link href="/verify" className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }}>
              {t("directCta")}
              <IconArrowRight size={14} />
            </Link>
          </div>

          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div
              style={{
                width: 38, height: 38,
                borderRadius: "var(--radius-sm)",
                background: "rgba(62,207,142,0.08)",
                border: "1px solid rgba(62,207,142,0.18)",
                display: "grid", placeItems: "center",
              }}
            >
              <IconRouteSquare size={20} stroke={1.5} color="var(--accent)" />
            </div>
            <div>
              <h3 style={{ marginBottom: "0.5rem" }}>{t("throughAppTitle")}</h3>
              <p className="muted" style={{ fontSize: "0.9rem", lineHeight: 1.65 }}>{t("throughAppBody")}</p>
            </div>
            <div className="row mono" style={{ gap: "0.5rem", fontSize: "0.8rem", color: "var(--muted)", flexWrap: "wrap" }}>
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
            <IconCode size={13} stroke={2} /> {t("devEyebrow")}
          </p>
          <h2>{t("devTitle")}</h2>
        </div>

        <div className="grid grid-3" style={{ gap: "1.25rem" }}>
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <p className="feature-num">01</p>
            <h3 style={{ fontSize: "1rem" }}>{t("devFeature1")}</h3>
            <CodeBlock>{`stellarcred.hasClaim(\n  wallet, 'kyc'\n)`}</CodeBlock>
          </div>
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <p className="feature-num">02</p>
            <h3 style={{ fontSize: "1rem" }}>{t("devFeature2")}</h3>
            <CodeBlock>{`StellarCred.buildVerifyUrl({\n  returnUrl,\n  claim: 'kyc'\n})`}</CodeBlock>
          </div>
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <p className="feature-num">03</p>
            <h3 style={{ fontSize: "1rem" }}>{t("devFeature3")}</h3>
            <p className="muted" style={{ fontSize: "0.875rem", lineHeight: 1.65 }}>{t("devFeature3Body")}</p>
          </div>
        </div>

        <div style={{ marginTop: "1.75rem" }}>
          <Link href="/developers" className="btn btn-secondary btn-sm">
            {t("devCta")}
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
          <h2 style={{ marginBottom: "0.75rem" }}>{t("ctaTitle")}</h2>
          <p className="muted" style={{ marginBottom: "2rem", maxWidth: 440, margin: "0 auto 2rem" }}>
            {t("ctaBody")}
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
              {t("ctaStart")}
              <IconArrowRight size={16} />
            </Link>
            <Link href="/holder" className="btn btn-secondary btn-lg">
              {t("ctaDashboard")}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
