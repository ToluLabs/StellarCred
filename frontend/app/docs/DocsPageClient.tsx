"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import Link from "next/link";

import {
  IconArrowRight,
  IconShieldCheck,
  IconFingerprint,
  IconBolt,
  IconCloudUpload,
  IconLock,
  IconCode,
  IconDatabase,
  IconSearch,
  IconX,
  IconHash,
} from "@tabler/icons-react";

interface TocItem {
  id: string;
  label: string;
  level: number;
  content: string;
}

const INITIAL_TOC: TocItem[] = [
  { id: "overview", label: "Overview", level: 2, content: "" },
  { id: "how-it-works", label: "How it works", level: 2, content: "" },
  { id: "credentials", label: "Credential types", level: 2, content: "" },
  { id: "zk-proofs", label: "ZK proof system", level: 2, content: "" },
  { id: "contracts", label: "Smart contracts", level: 2, content: "" },
  { id: "privacy", label: "Privacy model", level: 2, content: "" },
  { id: "storage", label: "Where your credentials live", level: 2, content: "" },
  { id: "toolchain", label: "Toolchain", level: 2, content: "" },
  { id: "get-started", label: "Get started", level: 2, content: "" },
];

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="heading-group" style={{ scrollMarginTop: "80px", fontSize: "1.35rem", marginBottom: "1rem", paddingBottom: "0.75rem", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: "0.6rem", position: "relative" }}>
      <a href={`#${id}`} aria-label={typeof children === "string" ? `Link to section: ${children}` : `Link to section: ${id}`} style={{ color: "inherit", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.6rem" }}>
        {children}
        <span style={{ color: "var(--accent)", display: "inline-flex", alignItems: "center", marginLeft: "0.2rem" }} className="anchor-link-icon" title={`Deep link to #${id}`}>
          <IconHash size={18} stroke={2} />
        </span>
      </a>
    </h2>
  );
}

function SubHeading({ id, children }: { id?: string; children: React.ReactNode }) {
  const autoId = id || (typeof children === "string" ? children.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : undefined);
  return (
    <h3 id={autoId} className="heading-group" style={{ scrollMarginTop: "80px", fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem", marginTop: "1.75rem", color: "var(--text)", display: "flex", alignItems: "center", gap: "0.5rem", position: "relative" }}>
      {autoId ? (
        <a href={`#${autoId}`} aria-label={`Link to section: ${autoId}`} style={{ color: "inherit", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
          {children}
          <span style={{ color: "var(--accent)", display: "inline-flex", alignItems: "center", marginLeft: "0.2rem" }} className="anchor-link-icon" title={`Deep link to #${autoId}`}>
            <IconHash size={15} stroke={2} />
          </span>
        </a>
      ) : (
        children
      )}
    </h3>
  );
}

function P({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <p style={{ color: "var(--muted)", lineHeight: 1.75, marginBottom: "0.9rem", fontSize: "0.9375rem", ...style }}>
      {children}
    </p>
  );
}

function Callout({ variant = "info", children }: { variant?: "info" | "warn" | "accent"; children: React.ReactNode }) {
  const colors = {
    info: { border: "rgba(255,255,255,0.1)", bg: "rgba(255,255,255,0.03)", color: "var(--muted)" },
    warn: { border: "rgba(227,179,65,0.25)", bg: "rgba(227,179,65,0.06)", color: "var(--warn)" },
    accent: { border: "rgba(62,207,142,0.25)", bg: "rgba(62,207,142,0.06)", color: "var(--accent)" },
  }[variant];
  return (
    <div style={{ border: `1px solid ${colors.border}`, background: colors.bg, borderRadius: "var(--radius)", padding: "0.9rem 1.1rem", marginBottom: "1rem", fontSize: "0.875rem", color: colors.color, lineHeight: 1.65 }}>
      {children}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.8rem", background: "rgba(255,255,255,0.06)", border: "1px solid var(--border)", borderRadius: "4px", padding: "0.15em 0.4em", color: "var(--accent)" }}>
      {children}
    </code>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.8rem", background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "1rem 1.25rem", overflowX: "auto", lineHeight: 1.7, color: "var(--muted)", marginBottom: "1rem", whiteSpace: "pre" }}>
      <code style={{ color: "var(--text)" }}>{children}</code>
    </pre>
  );
}

function ContractRow({ name, role }: { name: string; role: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: "0.9rem", padding: "0.8rem 0", borderBottom: "1px solid var(--border)" }}>
      <code style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.78rem", color: "var(--accent)", background: "rgba(62,207,142,0.08)", border: "1px solid rgba(62,207,142,0.2)", borderRadius: "4px", padding: "0.15em 0.5em", whiteSpace: "nowrap", marginTop: "1px", flexShrink: 0 }}>
        {name}
      </code>
      <span style={{ color: "var(--muted)", fontSize: "0.875rem", lineHeight: 1.6 }}>{role}</span>
    </div>
  );
}

function CredRow({ type, title, claim, attribute, private: priv }: { type: string; title: string; claim: string; attribute: string; private: string }) {
  return (
    <div className="card" style={{ padding: "1rem 1.25rem", marginBottom: "0.75rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.4rem", gap: "0.75rem", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <code style={{ fontFamily: "var(--font-mono), monospace", fontSize: "0.72rem", color: "var(--accent)", background: "rgba(62,207,142,0.08)", border: "1px solid rgba(62,207,142,0.2)", borderRadius: "4px", padding: "0.1em 0.45em" }}>{type}</code>
          <strong style={{ fontSize: "0.9rem" }}>{title}</strong>
        </div>
        <span style={{ fontSize: "0.75rem", color: "var(--accent)", background: "rgba(62,207,142,0.08)", border: "1px solid rgba(62,207,142,0.18)", borderRadius: "999px", padding: "0.15rem 0.6rem" }}>{claim}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginTop: "0.6rem" }}>
        <div>
          <div style={{ fontSize: "0.7rem", color: "var(--faint)", marginBottom: "0.15rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Attribute</div>
          <div style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{attribute}</div>
        </div>
        <div>
          <div style={{ fontSize: "0.7rem", color: "var(--faint)", marginBottom: "0.15rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Kept private</div>
          <div style={{ fontSize: "0.8125rem", color: "var(--muted)", display: "flex", alignItems: "center", gap: "0.3rem" }}>
            <IconLock size={11} />
            {priv}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DocsPageClient() {
  const [active, setActive] = useState("overview");
  const [toc, setToc] = useState<TocItem[]>(INITIAL_TOC);
  const [filterQuery, setFilterQuery] = useState("");
  const observerRef = useRef<IntersectionObserver | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const headingElements = Array.from(
      document.querySelectorAll("article h2, article h3")
    );
    const items: TocItem[] = headingElements.map((el) => {
      if (!el.id) {
        const slug =
          el.textContent
            ?.trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "section";
        el.id = slug;
      }
      const section = el.closest("section");
      const contentText = section ? section.textContent || "" : el.textContent || "";
      return {
        id: el.id,
        label: el.textContent?.trim() || "",
        level: el.tagName.toLowerCase() === "h3" ? 3 : 2,
        content: contentText.toLowerCase(),
      };
    });
    if (items.length > 0) {
      setToc(items);
    }
  }, []);

  useEffect(() => {
    if (toc.length === 0) return;
    observerRef.current?.disconnect();
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(e.target.id);
        }
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 }
    );
    toc.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observerRef.current!.observe(el);
    });

    const handleScroll = () => {
      if (
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 50
      ) {
        if (toc.length > 0) {
          setActive(toc[toc.length - 1].id);
        }
      }
    };
    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      observerRef.current?.disconnect();
      window.removeEventListener("scroll", handleScroll);
    };
  }, [toc]);

  useEffect(() => {
    const handleHashChange = () => {
      if (window.location.hash) {
        const id = window.location.hash.slice(1);
        if (id) {
          const el = document.getElementById(id);
          if (el) {
            el.scrollIntoView({ behavior: "smooth" });
            setActive(id);
          }
        }
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    const timer = setTimeout(() => {
      handleHashChange();
    }, 150);

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
      clearTimeout(timer);
    };
  }, []);

  const filteredToc = useMemo(() => {
    if (!filterQuery.trim()) return toc;
    const lower = filterQuery.trim().toLowerCase();
    return toc.filter(
      (item) =>
        item.label.toLowerCase().includes(lower) || item.content.includes(lower)
    );
  }, [toc, filterQuery]);

  const jumpToFirstMatch = useCallback(
    (query?: string) => {
      const q = query !== undefined ? query : filterQuery;
      if (!q.trim()) return;
      const lower = q.trim().toLowerCase();
      const match = toc.find(
        (item) =>
          item.label.toLowerCase().includes(lower) ||
          item.content.includes(lower)
      );
      if (match) {
        const el = document.getElementById(match.id);
        if (el) {
          el.scrollIntoView({ behavior: "smooth" });
          setActive(match.id);
          window.history.pushState(null, "", `#${match.id}`);
        }
      }
    },
    [filterQuery, toc]
  );

  const handleFilterChange = (val: string) => {
    setFilterQuery(val);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (!val.trim()) return;

    debounceTimerRef.current = setTimeout(() => {
      jumpToFirstMatch(val);
    }, 350);
  };

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  return (
    <div style={{ maxWidth: "var(--maxw)", margin: "0 auto" }}>
      <div className="reveal" style={{ marginBottom: "3.5rem", paddingTop: "0.5rem" }}>
        <span
          className="eyebrow row"
          style={{
            display: "inline-flex",
            gap: "0.4rem",
            padding: "0.3rem 0.7rem",
            background: "rgba(62,207,142,0.07)",
            border: "1px solid rgba(62,207,142,0.2)",
            borderRadius: "999px",
            color: "var(--accent)",
            marginBottom: "1.25rem",
          }}
        >
          <IconShieldCheck size={12} stroke={2} />
          Documentation
        </span>
        <h1 style={{ marginBottom: "0.6rem", fontSize: "clamp(1.8rem, 3.5vw, 2.5rem)" }}>
          About StellarCred
        </h1>
        <p className="lead" style={{ fontSize: "0.95rem" }}>
          Zero-knowledge credential infrastructure on Stellar. Prove facts about
          yourself without the data ever touching the chain.
        </p>
      </div>

      <div
        className="docs-layout"
        style={{
          display: "grid",
          gridTemplateColumns: "200px 1fr",
          gap: "4rem",
          alignItems: "start",
        }}
      >
        <aside
          className="docs-sidebar"
          style={{
            position: "sticky",
            top: "80px",
            display: "flex",
            flexDirection: "column",
            gap: "0.15rem",
            maxHeight: "calc(100vh - 100px)",
            overflowY: "auto",
            paddingRight: "0.5rem",
          }}
        >
          <div style={{ marginBottom: "0.85rem" }}>
            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
              }}
            >
              <IconSearch
                size={14}
                color="var(--faint)"
                style={{
                  position: "absolute",
                  left: "0.6rem",
                  pointerEvents: "none",
                }}
              />
              <input
                type="search"
                placeholder="Filter sections..."
                aria-label="Filter documentation sections"
                value={filterQuery}
                onChange={(e) => handleFilterChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    jumpToFirstMatch();
                  }
                }}
                style={{
                  width: "100%",
                  padding: "0.45rem 1.8rem 0.45rem 2rem",
                  fontSize: "0.8rem",
                  background: "var(--input)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--text)",
                  outline: "none",
                  transition: "border-color 0.15s ease",
                }}
                onFocus={(e) => (e.target.style.borderColor = "var(--accent)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
              />
              {filterQuery && (
                <button
                  type="button"
                  aria-label="Clear filter"
                  onClick={() => {
                    handleFilterChange("");
                  }}
                  style={{
                    position: "absolute",
                    right: "0.5rem",
                    background: "transparent",
                    border: "none",
                    color: "var(--faint)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    padding: 0,
                  }}
                >
                  <IconX size={13} />
                </button>
              )}
            </div>
          </div>

          <p
            style={{
              fontSize: "0.7rem",
              fontWeight: 600,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
              color: "var(--faint)",
              marginBottom: "0.5rem",
              paddingLeft: "0.6rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span>On this page</span>
            {filterQuery && (
              <span style={{ fontSize: "0.65rem", color: "var(--accent)", textTransform: "none" }}>
                {filteredToc.length} {filteredToc.length === 1 ? "match" : "matches"}
              </span>
            )}
          </p>

          {filteredToc.length > 0 ? (
            filteredToc.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  const el = document.getElementById(item.id);
                  if (el) {
                    el.scrollIntoView({ behavior: "smooth" });
                    setActive(item.id);
                    window.history.pushState(null, "", `#${item.id}`);
                  }
                }}
                style={{
                  fontSize: item.level === 3 ? "0.78rem" : "0.84rem",
                  padding: "0.4rem 0.6rem",
                  paddingLeft: item.level === 3 ? "1.4rem" : "0.6rem",
                  borderRadius: "var(--radius-xs)",
                  color: active === item.id ? "var(--accent)" : "var(--muted)",
                  background: active === item.id ? "rgba(62,207,142,0.08)" : "transparent",
                  borderLeft: active === item.id
                    ? "2px solid var(--accent)"
                    : "2px solid transparent",
                  transition: "all 0.15s var(--ease)",
                  lineHeight: 1.4,
                  display: "block",
                  textDecoration: "none",
                  fontWeight: active === item.id ? 600 : 400,
                }}
              >
                {item.label}
              </a>
            ))
          ) : (
            <div
              style={{
                padding: "0.75rem 0.6rem",
                fontSize: "0.8rem",
                color: "var(--faint)",
                fontStyle: "italic",
              }}
            >
              No matching sections
            </div>
          )}
        </aside>

        <article style={{ minWidth: 0 }}>
          <section style={{ marginBottom: "3.5rem" }}>
            <SectionHeading id="overview">
              <IconShieldCheck size={20} color="var(--accent)" stroke={1.8} />
              Overview
            </SectionHeading>
            <P>
              StellarCred is a zero-knowledge credential system built on Stellar. It lets a
              trusted issuer sign claims about a holder — KYC status, age, income, jurisdiction
              — and lets that holder later prove those claims on-chain without revealing the
              underlying data.
            </P>
            <P>
              Every proof is generated locally in the holder&apos;s browser using the{" "}
              <strong style={{ color: "var(--text)" }}>UltraHonk</strong> proof system
              (Noir 1.0.0-beta.9 / Barretenberg 0.87.0). The Stellar chain stores only a
              compact verification record — no personal data touches the ledger.
            </P>
            <Callout variant="accent">
              <strong>Core guarantee:</strong> A verifier reading <Code>ProofRegistry.is_verified</Code>{" "}
              learns that a holder satisfies a claim, and nothing else. Not their name, date of
              birth, income figure, or country — only the boolean result.
            </Callout>
          </section>

          <section style={{ marginBottom: "3.5rem" }}>
            <SectionHeading id="how-it-works">
              <IconBolt size={20} color="var(--accent)" stroke={1.8} />
              How it works
            </SectionHeading>
            {[
              {
                n: "01",
                icon: <IconFingerprint size={16} stroke={1.6} color="var(--accent)" />,
                title: "Issue",
                body: (
                  <>
                    The issuer calls <Code>POST /api/issue</Code> (server-side) with the holder&apos;s
                    wallet address and the relevant attribute (e.g. date of birth). The server
                    computes a <strong style={{color:"var(--text)"}}>Poseidon2 commitment</strong>{" "}
                    over <Code>(value, salt)</Code>, signs the commitment with a secp256k1 demo key,
                    and returns the full credential JSON. The credential is stored in the holder&apos;s
                    <Code>localStorage</Code> — never on a server.
                  </>
                ),
              },
              {
                n: "02",
                icon: <IconBolt size={16} stroke={1.6} color="var(--accent)" />,
                title: "Prove",
                body: (
                  <>
                    The holder clicks <em>Generate proof</em>. Their credential inputs are sent
                    to <Code>POST /api/witness</Code>, which executes the Noir circuit server-side
                    and returns the witness bytes. The browser then loads{" "}
                    <Code>/bb/index.js</Code> (the pre-built Barretenberg browser bundle) and calls{" "}
                    <Code>UltraHonkBackend.generateProof(witness)</Code> — pure client-side WASM proving.
                    The proof is ~14 KB.
                  </>
                ),
              },
              {
                n: "03",
                icon: <IconCloudUpload size={16} stroke={1.6} color="var(--accent)" />,
                title: "Verify",
                body: (
                  <>
                    The holder submits the proof to <Code>ProofRegistry.submit_proof</Code> via a
                    wallet-signed Stellar transaction. The registry checks the issuer is trusted
                    via <Code>IssuerRegistry</Code>, verifies the on-chain public key matches the
                    one in the proof&apos;s public inputs, and forwards to <Code>CredentialVerifier</Code>{" "}
                    which runs the BN254 UltraHonk verifier as a Soroban host function. If all pass,
                    a record <Code>(verified_at, expiry)</Code> is written to persistent storage.
                    Any protocol can then call <Code>ProofRegistry.is_verified</Code> — a free,
                    read-only simulation.
                  </>
                ),
              },
            ].map((step) => (
              <div
                key={step.n}
                style={{
                  display: "flex",
                  gap: "1.1rem",
                  marginBottom: "1.5rem",
                  alignItems: "flex-start",
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: "var(--radius-sm)",
                    background: "rgba(62,207,142,0.07)",
                    border: "1px solid rgba(62,207,142,0.18)",
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                    marginTop: "2px",
                  }}
                >
                  {step.icon}
                </div>
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      marginBottom: "0.4rem",
                    }}
                  >
                    <span
                      className="mono"
                      style={{ color: "var(--faint)", fontSize: "0.7rem" }}
                    >
                      {step.n}
                    </span>
                    <strong style={{ fontSize: "0.9375rem" }}>{step.title}</strong>
                  </div>
                  <p style={{ color: "var(--muted)", lineHeight: 1.7, fontSize: "0.9rem" }}>
                    {step.body}
                  </p>
                </div>
              </div>
            ))}
          </section>

          <section style={{ marginBottom: "3.5rem" }}>
            <SectionHeading id="credentials">
              <IconFingerprint size={20} color="var(--accent)" stroke={1.8} />
              Credential types
            </SectionHeading>
            <P>
              Each credential type has a dedicated Noir circuit. The circuit proves the
              claim using the commitment, the issuer&apos;s signature, and optional public
              parameters — all without revealing the underlying attribute.
            </P>
            <CredRow
              type="kyc"
              title="KYC Complete"
              claim="identity verified"
              attribute="None (random secret proves liveness)"
              private="The secret value"
            />
            <CredRow
              type="age"
              title="Age Verified"
              claim="age ≥ 18"
              attribute="Date of birth (stored as days since epoch)"
              private="Exact date of birth"
            />
            <CredRow
              type="income"
              title="Accredited Investor"
              claim="income > $200k"
              attribute="Annual income in USD"
              private="Exact income figure"
            />
            <CredRow
              type="jurisdiction"
              title="Jurisdiction Eligible"
              claim="country not restricted"
              attribute="ISO 3166-1 numeric country code"
              private="Exact country code"
            />
            <CredRow
              type="funds"
              title="Proof of Funds"
              claim="balance > $10,000"
              attribute="Account balance from Plaid (verified by bank, never stored)"
              private="Exact balance figure"
            />
            <CredRow
              type="accreditation"
              title="Accredited Investor (Net Worth)"
              claim="net worth ≥ $1,000,000"
              attribute="Net worth in USD"
              private="Exact net worth figure"
            />
          </section>

          <section style={{ marginBottom: "3.5rem" }}>
            <SectionHeading id="zk-proofs">
              <IconCode size={20} color="var(--accent)" stroke={1.8} />
              ZK proof system
            </SectionHeading>
            <SubHeading id="ultrahonk">UltraHonk</SubHeading>
            <P>
              StellarCred uses the <strong style={{color:"var(--text)"}}>UltraHonk</strong> proving
              system from the Aztec Barretenberg library. UltraHonk is a PLONK-family
              argument over the BN254 elliptic curve with a Keccak transcript, matching the
              on-chain verifier exposed as a Soroban host function in Stellar Protocol 22.
            </P>
            <P>
              Proofs are generated in the browser via the pre-built Barretenberg WASM bundle
              (served from <Code>/bb/index.js</Code>), avoiding any dependency on
              webpack for the heavy proving machinery.
            </P>
            <SubHeading id="poseidon2-commitment">Poseidon2 commitment</SubHeading>
            <P>
              The credential stores a <strong style={{color:"var(--text)"}}>Poseidon2 hash</strong>{" "}
              of the attribute value and a random 248-bit salt:
            </P>
            <CodeBlock>{`commitment = Poseidon2([value, salt])`}</CodeBlock>
            <P>
              Poseidon2 is ZK-friendly — it is cheap to prove inside a Noir circuit while
              being collision-resistant. The salt prevents dictionary attacks on the
              commitment even for low-entropy values like country codes.
            </P>
            <SubHeading id="secp256k1-issuer-signature">secp256k1 issuer signature</SubHeading>
            <P>
              After computing the commitment, the issuer signs it with a{" "}
              <strong style={{color:"var(--text)"}}>secp256k1 ECDSA</strong> key using{" "}
              <Code>prehash: false</Code> — Noir uses the raw 32-byte commitment as the
              message digest directly. Each Noir circuit verifies this signature inside the
              proof, binding the claim to a specific registered issuer public key.
            </P>
            <Callout variant="warn">
              The demo issuer&rsquo;s signing key lives only in the Next.js server process — never in
              the browser. In production, each issuer would hold their own secret key in a hardware
              security module or secrets manager.
            </Callout>
          </section>

          <section style={{ marginBottom: "3.5rem" }}>
            <SectionHeading id="contracts">
              <IconDatabase size={20} color="var(--accent)" stroke={1.8} />
              Smart contracts
            </SectionHeading>
            <P>
              Four Soroban contracts are deployed on Stellar testnet. They are wired at deploy
              time and communicate through typed contract clients (no shared library
              dependencies between them).
            </P>
            <div style={{ marginBottom: "0.25rem" }}>
              <ContractRow
                name="IssuerRegistry"
                role="Stores trusted issuer addresses, their secp256k1 public keys, and which credential types each is authorised to issue. Admins call register_issuer; anyone can read is_valid_issuer and get_issuer_pubkey."
              />
              <ContractRow
                name="CredentialVerifier"
                role="Holds a verification key (VK) per credential type. submit_proof calls the BN254 UltraHonk host function with the VK and the provided proof + public inputs. Returns bool."
              />
              <ContractRow
                name="ProofRegistry"
                role="The public API for downstream protocols. Calls IssuerRegistry to check trust, verifies the public key in the proof's public inputs matches the registered key, calls CredentialVerifier, and writes (holder, type) → (verified_at, expiry) to persistent storage."
              />
              <ContractRow
                name="GatedPool"
                role="Demo protocol. Reads ProofRegistry.is_verified(holder, kyc|age|income) before allowing a deposit. Shows how any protocol can gate actions on ZK proofs without owning the verification logic."
              />
            </div>
            <SubHeading id="public-input-layout">Public-input layout</SubHeading>
            <P>
              Each circuit outputs the following public inputs (32 bytes per field, big-endian):
            </P>
            <CodeBlock>{`field 0       commitment (Poseidon2 hash)
fields 1–32   issuer_x   (secp256k1 X, one byte per field in low byte)
fields 33–64  issuer_y   (secp256k1 Y, one byte per field in low byte)`}</CodeBlock>
            <P>
              <Code>ProofRegistry</Code> extracts fields 1–64 and compares them byte-by-byte
              against the registered issuer key, preventing a holder from substituting an
              attacker-controlled key.
            </P>
          </section>

          <section style={{ marginBottom: "3.5rem" }}>
            <SectionHeading id="privacy">
              <IconLock size={20} color="var(--accent)" stroke={1.8} />
              Privacy model
            </SectionHeading>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "1rem",
                marginBottom: "1.25rem",
              }}
            >
              <div className="card" style={{ padding: "1.1rem 1.25rem" }}>
                <div
                  style={{
                    fontSize: "0.72rem",
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--faint)",
                    marginBottom: "0.75rem",
                  }}
                >
                  Stays on device
                </div>
                {[
                  "Raw attribute (age, income, country)",
                  "Random salt",
                  "Full credential JSON",
                  "Issuer signature",
                  "Witness bytes",
                ].map((item) => (
                  <div
                    key={item}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      fontSize: "0.8375rem",
                      color: "var(--muted)",
                      padding: "0.3rem 0",
                    }}
                  >
                    <IconLock size={11} color="var(--faint)" />
                    {item}
                  </div>
                ))}
              </div>
              <div className="card card-accent" style={{ padding: "1.1rem 1.25rem" }}>
                <div
                  style={{
                    fontSize: "0.72rem",
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--accent)",
                    marginBottom: "0.75rem",
                  }}
                >
                  Goes on-chain
                </div>
                {[
                  "Proof bytes (~14 KB)",
                  "Public inputs (commitment + issuer pubkey)",
                  "Holder address",
                  "Credential type (symbol)",
                  "Expiry timestamp",
                ].map((item) => (
                  <div
                    key={item}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      fontSize: "0.8375rem",
                      color: "var(--muted)",
                      padding: "0.3rem 0",
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--accent)",
                        flexShrink: 0,
                      }}
                    />
                    {item}
                  </div>
                ))}
              </div>
            </div>
            <Callout variant="info">
              The commitment that appears in the public inputs is a hash — it reveals nothing
              about the underlying value without the salt. Even if the chain is public, an
              observer learns only that <em>some</em> holder with <em>some</em> credential passed
              verification at a given time.
            </Callout>
          </section>

          <section style={{ marginBottom: "3.5rem" }}>
            <SectionHeading id="storage">
              <IconDatabase size={20} color="var(--accent)" stroke={1.8} />
              Where your credentials live
            </SectionHeading>
            <P>
              Your credentials — including the raw attribute value (date of birth, income,
              balance…) and its random salt — are stored <strong style={{color:"var(--text)"}}>only in
              this browser&apos;s <Code>localStorage</Code></strong>, under the key{" "}
              <Code>stellarcred:credentials</Code>. There is no StellarCred account and no
              server-side credential database: the credential JSON exists only on the device
              that received it.
            </P>
            <Callout variant="warn">
              <strong>Credentials are browser-specific and can be lost permanently.</strong>{" "}
              Clearing site data, switching to a different browser or device, or browsing in
              private/incognito mode erases them — there is no server-side copy to recover
              them from. Back up (below) before any of those happen.
            </Callout>
            <SubHeading>Back up and restore</SubHeading>
            <P>
              Open the <strong style={{color:"var(--text)"}}>Holder</strong> page and click{" "}
              <strong style={{color:"var(--text)"}}>Export backup</strong> — the browser downloads a JSON
              file containing every credential. Keep that file somewhere safe: it contains the
              raw sensitive attribute values, so treat it like a password. To restore — on a new
              browser, a new device, or after clearing site data — open the Holder page there,
              click <strong style={{color:"var(--text)"}}>Import credential JSON</strong>, and paste the
              file&apos;s contents. Restored credentials generate and submit proofs exactly like
              newly issued ones.
            </P>
            <P>
              To move a single credential to another device, open its details (click the
              credential on the Holder page) and choose{" "}
              <strong style={{color:"var(--text)"}}>Transfer to another device</strong>. You pick a
              passphrase and the app shows a QR code; the credential is encrypted with that
              passphrase (AES-256-GCM, key derived via PBKDF2 — see <Code>lib/crypto.ts</Code>)
              before it ever becomes a QR code, so the code alone reveals nothing. On the other
              device, scan the QR and enter the same passphrase to import.
            </P>
            <SubHeading>What is stored, and where</SubHeading>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "1rem",
                marginBottom: "1.25rem",
              }}
            >
              <div className="card" style={{ padding: "1.1rem 1.25rem" }}>
                <div
                  style={{
                    fontSize: "0.72rem",
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--faint)",
                    marginBottom: "0.75rem",
                  }}
                >
                  Stored on this device
                </div>
                {[
                  "Raw attribute (age, income, country, …)",
                  "Random salt",
                  "Full credential JSON + issuer signature",
                  "Proof status (provedAt / tx hash)",
                ].map((item) => (
                  <div
                    key={item}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      fontSize: "0.8375rem",
                      color: "var(--muted)",
                      padding: "0.3rem 0",
                    }}
                  >
                    <IconLock size={11} color="var(--faint)" />
                    {item}
                  </div>
                ))}
              </div>
              <div className="card card-accent" style={{ padding: "1.1rem 1.25rem" }}>
                <div
                  style={{
                    fontSize: "0.72rem",
                    fontWeight: 600,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "var(--accent)",
                    marginBottom: "0.75rem",
                  }}
                >
                  Never stored on a server
                </div>
                {[
                  "Credential value / salt",
                  "Credential JSON (discarded after use)",
                  "Passphrase or derived key",
                ].map((item) => (
                  <div
                    key={item}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      fontSize: "0.8375rem",
                      color: "var(--muted)",
                      padding: "0.3rem 0",
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--accent)",
                        flexShrink: 0,
                      }}
                    />
                    {item}
                  </div>
                ))}
              </div>
            </div>
            <P>
              One nuance: while <em>stored</em> credentials never leave your device, generating a
              proof sends your credential inputs to <Code>POST /api/witness</Code> (StellarCred&apos;s
              own server), which executes the Noir circuit and returns the witness bytes; the
              proof itself is then computed in your browser. That route is rate-limited, never
              logs the sensitive fields, and does not persist the credential — the values exist
              only in transit for that single request (see <em>How it works</em> above).
            </P>
            <P>
              On the chain side, submitting a proof writes only the public inputs — the
              commitment (a hash), the issuer&apos;s public key, the credential type, and an expiry
              timestamp — plus the ~14 KB proof bytes. See <em>Privacy model</em> above for the
              full breakdown.
            </P>
          </section>

          <section style={{ marginBottom: "3.5rem" }}>
            <SectionHeading id="toolchain">
              <IconCode size={20} color="var(--accent)" stroke={1.8} />
              Toolchain
            </SectionHeading>
            <div style={{ marginBottom: "1.25rem" }}>
              {[
                { name: "Noir", ver: "1.0.0-beta.9", role: "Circuit language & compiler" },
                { name: "Barretenberg", ver: "0.87.0", role: "UltraHonk prover / verifier (bb CLI + bb.js)" },
                { name: "Stellar CLI", ver: "26+", role: "Contract deploy & invoke (Protocol 22 / BN254 host fns)" },
                { name: "soroban-sdk", ver: "22", role: "Rust contract framework" },
                { name: "@stellar/stellar-sdk", ver: "13.3.0", role: "TypeScript client" },
                { name: "Next.js", ver: "14.2", role: "Frontend framework (App Router)" },
              ].map((row, i) => (
                <div
                  key={row.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.8rem",
                    padding: "0.65rem 0",
                    borderTop: i === 0 ? "none" : "1px solid var(--border)",
                  }}
                >
                  <code
                    style={{
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: "0.78rem",
                      color: "var(--text)",
                      minWidth: 170,
                    }}
                  >
                    {row.name}
                  </code>
                  <code
                    style={{
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: "0.75rem",
                      color: "var(--accent)",
                      background: "rgba(62,207,142,0.07)",
                      border: "1px solid rgba(62,207,142,0.18)",
                      borderRadius: "4px",
                      padding: "0.1em 0.4em",
                      flexShrink: 0,
                    }}
                  >
                    {row.ver}
                  </code>
                  <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
                    {row.role}
                  </span>
                </div>
              ))}
            </div>
            <SubHeading id="build-circuits">Build circuits</SubHeading>
            <CodeBlock>{`# From repo root
cd circuits
bash scripts/build.sh          # compiles all 5 circuits + commit helper
                               # outputs *.json to frontend/public/circuits/
                               # outputs VKs to fixtures/*/vk`}</CodeBlock>
            <SubHeading id="deploy-contracts">Deploy contracts</SubHeading>
            <CodeBlock>{`stellar keys generate --global deployer --network testnet --fund
SOURCE=deployer ./scripts/deploy.sh
# Copy the printed NEXT_PUBLIC_* vars into frontend/.env.local`}</CodeBlock>
          </section>

          <section style={{ marginBottom: "2rem" }}>
            <SectionHeading id="get-started">
              <IconBolt size={20} color="var(--accent)" stroke={1.8} />
              Get started
            </SectionHeading>
            <P>
              The fastest way to see StellarCred in action on testnet — no local build needed:
            </P>
            <ol
              style={{
                color: "var(--muted)",
                lineHeight: 1.9,
                fontSize: "0.9375rem",
                paddingLeft: "1.25rem",
                marginBottom: "1.5rem",
              }}
            >
              <li>
                Install a <strong style={{color:"var(--text)"}}>Stellar wallet</strong> (Freighter,
                Albedo, xBull, and others are supported) and switch it to{" "}
                <strong style={{color:"var(--text)"}}>Testnet</strong>
              </li>
              <li>
                Fund your address via{" "}
                <strong style={{color:"var(--text)"}}>Stellar Friendbot</strong>{" "}
                (<Code>friendbot.stellar.org/?addr=YOUR_ADDRESS</Code>)
              </li>
              <li>
                Click <strong style={{color:"var(--text)"}}>Verify</strong> in
                the nav, connect your wallet, and request a KYC credential
              </li>
              <li>
                Go to <strong style={{color:"var(--text)"}}>Wallet</strong>, click
                <em> Generate proof</em> — the browser proves in ~10 seconds
              </li>
              <li>
                Click <strong style={{color:"var(--text)"}}>Submit to Stellar</strong>,
                approve in your wallet, and check the <strong style={{color:"var(--text)"}}>Apps</strong>{" "}
                page to see your eligibility update live
              </li>
            </ol>

            <div
              style={{
                display: "flex",
                gap: "0.65rem",
                flexWrap: "wrap",
                paddingTop: "0.5rem",
              }}
            >
              <Link href="/verify" className="btn btn-primary">
                Get a credential
                <IconArrowRight size={15} />
              </Link>
              <Link href="/holder" className="btn btn-secondary">
                Open dashboard
              </Link>
              <Link href="/apps" className="btn btn-ghost">
                Explore apps
                <IconArrowRight size={15} />
              </Link>
            </div>
          </section>
        </article>
      </div>
    </div>
  );
}
