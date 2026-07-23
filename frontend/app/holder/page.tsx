"use client";

import { useEffect, useRef, useState } from "react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconExternalLink,
  IconPlus,
  IconAlertTriangle,
  IconTrash,
  IconCertificate,
  IconLoader2,
  IconServer,
  IconCpu,
  IconCloudUpload,
} from "@tabler/icons-react";
import SubmissionHistory from "@/components/SubmissionHistory";`nimport { saveSubmission } from "@/lib/history";`nimport { WalletButton } from "@/components/WalletButton";
import { useWallet } from "@/lib/wallet-context";
import { Badge } from "@/components/Badge";
import { Check } from "@/components/Check";
import { ConfigBanner } from "@/components/ConfigBanner";
import { truncateHash } from "@/lib/format";
import { EXPLORER_TX } from "@/lib/stellar";
import { computeWitness, proveWithBackend } from "@/lib/proof";
import { submitProof, parseContractError, type ContractError } from "@/lib/contracts";
import {
  type Credential,
  loadCredentials,
  saveCredential,
  removeCredential,
  markProved,
  parseCredential,
} from "@/lib/credential";

// Parse "90 days", "30 days" etc from the credential's expiry string.
function credTtlSecs(cred: Credential): number {
  const match = cred.expiry?.match(/(\d+)/);
  return (match ? parseInt(match[1]) : 30) * 86_400;
}

function proofStatus(cred: Credential): "unproved" | "proved" | "expired" {
  if (!cred.provedAt) return "unproved";
  return cred.provedAt + credTtlSecs(cred) > Math.floor(Date.now() / 1000)
    ? "proved"
    : "expired";
}

function daysRemaining(cred: Credential): number {
  if (!cred.provedAt) return 0;
  const secsLeft = cred.provedAt + credTtlSecs(cred) - Math.floor(Date.now() / 1000);
  return Math.max(0, Math.ceil(secsLeft / 86_400));
}

// ── Credential card ──────────────────────────────────────────────────────────

function CredCard({
  c,
  address,
  onProve,
  onRemove,
}: {
  c: Credential;
  address: string;
  onProve: () => void;
  onRemove: () => void;
}) {
  const status = proofStatus(c);

  return (
    <div className="card" style={{ padding: "1rem 1.25rem" }}>
      <div className="between" style={{ alignItems: "center", gap: "0.75rem" }}>
        {/* left: credential info */}
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{c.title}</span>
            <span className="mono faint" style={{ fontSize: "0.7rem" }}>{c.claim}</span>
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--faint)", marginTop: "0.15rem" }}>
            {c.issuer} · <span>{truncateHash(c.commitment)}</span>
            {status === "proved" && (
              <>
                {" · "}
                <span style={{ color: "var(--accent)", opacity: 0.75 }}>
                  expires in {daysRemaining(c)}d
                </span>
                {c.provedTxHash && (
                  <>
                    {" · "}
                    <a
                      href={EXPLORER_TX(c.provedTxHash)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "inherit", display: "inline-flex", alignItems: "center", gap: "0.15rem" }}
                    >
                      {c.provedTxHash.slice(0, 6)}…<IconExternalLink size={10} />
                    </a>
                  </>
                )}
              </>
            )}
            {status === "expired" && (
              <> · <span style={{ color: "var(--danger)", opacity: 0.8 }}>expired</span></>
            )}
          </div>
        </div>

        {/* right: badges + button + trash */}
        <div className="row" style={{ gap: "0.4rem", flexShrink: 0 }}>
          <Badge variant="verified" dot={false}>Held</Badge>
          {status === "proved" && <Badge variant="verified" dot={false}>On-chain</Badge>}
          <button
            className={`btn btn-sm ${status === "proved" ? "btn-secondary" : "btn-primary"}`}
            disabled={!address}
            title={!address ? "Connect a wallet first" : undefined}
            onClick={onProve}
          >
            {status === "proved"  ? "Re-prove" :
             status === "expired" ? "Re-prove" :
                                    "Generate proof"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="Remove"
            onClick={onRemove}
            style={{ padding: "0.3rem 0.4rem", color: "var(--faint)" }}
          >
            <IconTrash size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.6rem",
        marginBottom: "0.65rem",
        marginTop: "0.25rem",
      }}
    >
      <span
        style={{
          fontSize: "0.72rem",
          fontWeight: 600,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          color: "var(--faint)",
        }}
      >
        {children}
      </span>
      <div style={{ flex: 1, height: "1px", background: "var(--border)" }} />
    </div>
  );
}

// ── Holder page ───────────────────────────────────────────────────────────────

export default function HolderPage() {
  const { address } = useWallet();
  const [creds, setCreds] = useState<Credential[]>([]);
  const [proving, setProving] = useState<Credential | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => setCreds(loadCredentials()), []);

  const unproved = creds.filter((c) => proofStatus(c) !== "proved");
  const proved   = creds.filter((c) => proofStatus(c) === "proved");

  return (
    <>
      <div className="between" style={{ marginBottom: "2.5rem" }}>
        <div>
          <span className="eyebrow">Holder</span>
          <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>Your credentials</h1>
        </div>
        <WalletButton />
      </div>

      <ConfigBanner />

      {proving ? (
        <ProofFlow
          cred={proving}
          holder={address}
          onBack={() => setProving(null)}
          onProved={(txHash) => { setCreds(markProved(proving.commitment, txHash)); saveSubmission({ credentialType: proving.type, timestamp: Date.now(), txHash, status: "confirmed" }); }}
        />
      ) : (
        <div className="stack reveal" style={{ gap: "1.5rem" }}>

          {/* ── Empty state ── */}
          {creds.length === 0 && !importing && (
            <div
              className="card"
              style={{ textAlign: "center", padding: "3.5rem 1.5rem", borderStyle: "dashed" }}
            >
              <IconCertificate size={30} stroke={1.3} color="var(--faint)" />
              <h3 style={{ margin: "1rem 0 0.4rem" }}>No credentials yet</h3>
              <p className="muted" style={{ fontSize: "0.875rem", maxWidth: 340, margin: "0 auto 1.5rem" }}>
                Get a credential from a trusted issuer, then generate a
                zero-knowledge proof to verify it on-chain.
              </p>
              <a href="/verify" className="btn btn-primary btn-sm" style={{ display: "inline-flex" }}>
                Get a credential
                <IconArrowRight size={14} />
              </a>
            </div>
          )}

          {/* ── Credentials to prove ── */}
          {unproved.length > 0 && (
            <div className="stack" style={{ gap: "0.6rem" }}>
              <SectionLabel>Ready to prove</SectionLabel>
              {unproved.map((c) => (
                <CredCard
                  key={c.commitment}
                  c={c}
                  address={address}
                  onProve={() => setProving(c)}
                  onRemove={() => setCreds(removeCredential(c.commitment))}
                />
              ))}
            </div>
          )}

          {/* ── Already proved ── */}
          {proved.length > 0 && (
            <div className="stack" style={{ gap: "0.6rem" }}>
              <SectionLabel>On-chain · active proofs</SectionLabel>
              {proved.map((c) => (
                <CredCard
                  key={c.commitment}
                  c={c}
                  address={address}
                  onProve={() => setProving(c)}
                  onRemove={() => setCreds(removeCredential(c.commitment))}
                />
              ))}
            </div>
          )}

          {!address && creds.length > 0 && (
            <p className="faint" style={{ fontSize: "0.8125rem" }}>
              Connect a wallet to generate and submit proofs.
            </p>
          )}

          {importing ? (
            <ImportPanel
              onImport={(c) => { setCreds(saveCredential(c)); setImporting(false); }}
              onCancel={() => setImporting(false)}
            />
          ) : (
            <button
              className="btn btn-ghost btn-sm"
              style={{ alignSelf: "flex-start" }}
              onClick={() => setImporting(true)}
            >
              <IconPlus size={14} />
              Import credential JSON
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ── Import panel ──────────────────────────────────────────────────────────────

function ImportPanel({ onImport, onCancel }: { onImport: (c: Credential) => void; onCancel: () => void }) {
  const [json, setJson] = useState("");
  const [error, setError] = useState("");

  function onAdd() {
    try { onImport(parseCredential(json)); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="card reveal">
      <span className="eyebrow">Import credential</span>
      <textarea
        rows={5}
        placeholder='{"type":"kyc","commitment":"0x…", …}'
        value={json}
        onChange={(e) => setJson(e.target.value)}
        style={{ marginTop: "0.75rem" }}
      />
      {error && <p style={{ color: "var(--danger)", fontSize: "0.8125rem", marginTop: "0.5rem" }}>{error}</p>}
      <div className="row" style={{ marginTop: "1rem", gap: "0.6rem" }}>
        <button className="btn btn-primary btn-sm" onClick={onAdd} disabled={!json.trim()}>Add credential</button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── ProofFlow ─────────────────────────────────────────────────────────────────

type Stage = "witness" | "proving" | "generated" | "submitting" | "confirmed" | "error";

function ProofFlow({
  cred,
  holder,
  onBack,
  onProved,
}: {
  cred: Credential;
  holder: string;
  onBack: () => void;
  onProved: (txHash: string) => void;
}) {
  const [stage, setStage] = useState<Stage>("witness");
  const [proof, setProof] = useState<{ proof: Uint8Array; publicInputs: Uint8Array } | null>(null);
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState<ContractError | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  // elapsed time for the proving stage
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Stage 1: witness (server)
        const witness = await computeWitness(
          cred.type,
          cred as unknown as Record<string, unknown>,
        );
        if (cancelled) return;

        // Stage 2: prove (browser WASM)
        setStage("proving");
        const start = Date.now();
        timerRef.current = setInterval(
          () => setElapsed(Math.floor((Date.now() - start) / 1000)),
          1000,
        );

        const result = await proveWithBackend(
          cred.type,
          witness,
        );
        clearInterval(timerRef.current!);
        if (cancelled) return;

        setProof(result);
        setStage("generated");
      } catch (e) {
        clearInterval(timerRef.current!);
        if (!cancelled) {
          setError(parseContractError((e as Error).message));
          setStage("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(timerRef.current!);
    };
  }, [cred]);

  async function onSubmit() {
    if (!proof) return;
    setStage("submitting");
    try {
      const hash = await submitProof({
        holder,
        issuerId: cred.issuerId,
        credentialType: cred.type,
        proof: proof.proof,
        publicInputs: proof.publicInputs,
        ttlSecs: credTtlSecs(cred),
      });
      setTxHash(hash);
      onProved(hash);
      setStage("confirmed");
    } catch (e) {
      setError(parseContractError((e as Error).message));
      setStage("error");
    }
  }

  const proofDone = stage === "generated" || stage === "submitting" || stage === "confirmed";
  const submitDone = stage === "confirmed";

  return (
    <div className="reveal" style={{ maxWidth: 520, margin: "0 auto" }}>
      <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: "1.5rem" }}>
        <IconArrowLeft size={14} />
        All credentials
      </button>

      <div className="card" style={{ padding: "1.75rem" }}>
        {/* credential header */}
        <div style={{ marginBottom: "1.5rem" }}>
          <span className="eyebrow" style={{ marginBottom: "0.5rem", display: "block" }}>
            Proving
          </span>
          <h2 style={{ marginBottom: "0.25rem" }}>{cred.title}</h2>
          <span className="mono faint" style={{ fontSize: "0.8rem" }}>{cred.claim}</span>
        </div>

        {/* step list */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
          <ProofStep
            icon={<IconServer size={14} stroke={1.8} />}
            title="Compute witness"
            subtitle="Poseidon2 · secp256k1 · server-side Noir execution"
            state={
              stage === "witness"  ? "active" :
              stage === "error"    ? "idle"   : "done"
            }
            detail={
              stage === "witness" ? <AnimatedDots text="Running circuit on server" /> : null
            }
          />

          <ProofStep
            icon={<IconCpu size={14} stroke={1.8} />}
            title="UltraHonk proof"
            subtitle="BN254 · keccak transcript · browser WASM"
            state={
              stage === "proving"  ? "active" :
              proofDone            ? "done"   : "idle"
            }
            detail={
              stage === "proving" ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.65rem" }}>
                  <ProvingBar />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                      Generating proof in browser…
                    </span>
                    <span className="mono" style={{ fontSize: "0.72rem", color: "var(--faint)" }}>
                      {elapsed}s
                    </span>
                  </div>
                  <span style={{ fontSize: "0.72rem", color: "var(--faint)" }}>
                    First run loads the WASM prover (~5–15 s)
                  </span>
                </div>
              ) : proofDone && proof ? (
                <div style={{ marginTop: "0.4rem" }}>
                  <span className="mono" style={{ fontSize: "0.75rem", color: "var(--accent)" }}>
                    π {truncateHash("0x" + toHex(proof.proof))}
                  </span>
                  <span className="mono faint" style={{ fontSize: "0.72rem", marginLeft: "0.5rem" }}>
                    {proof.proof.length.toLocaleString()} bytes
                  </span>
                </div>
              ) : null
            }
          />

          <ProofStep
            icon={<IconCloudUpload size={14} stroke={1.8} />}
            title="Submit to Stellar"
            subtitle="ProofRegistry.submit_proof · Freighter signature"
            state={
              stage === "submitting" ? "active" :
              submitDone             ? "done"   : "idle"
            }
            last
            detail={
              stage === "submitting" ? (
                <AnimatedDots text="Writing to ProofRegistry" style={{ marginTop: "0.35rem" }} />
              ) : submitDone ? (
                <a
                  href={EXPLORER_TX(txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="row accent"
                  style={{ gap: "0.3rem", fontSize: "0.775rem", marginTop: "0.3rem" }}
                >
                  {txHash.slice(0, 8)}…{txHash.slice(-6)}
                  <IconExternalLink size={12} />
                </a>
              ) : null
            }
          />
        </div>

        {/* CTA */}
        {stage === "generated" && (
          <button
            className="btn btn-primary"
            style={{ marginTop: "1.5rem", width: "100%" }}
            onClick={onSubmit}
          >
            Submit to Stellar
            <IconArrowRight size={15} />
          </button>
        )}

        {stage === "error" && error && (
          <div
            style={{
              marginTop: "1.5rem",
              padding: "0.9rem 1.1rem",
              borderRadius: "var(--radius)",
              border: "1px solid rgba(240,96,77,0.3)",
              background: "rgba(240,96,77,0.06)",
            }}
          >
            <div className="row" style={{ gap: "0.5rem", color: "var(--danger)", fontWeight: 600, fontSize: "0.875rem" }}>
              <IconAlertTriangle size={15} />
              {error.code !== null ? `Contract error #${error.code}` : "Could not complete"}
            </div>
            <div style={{ fontSize: "0.8125rem", marginTop: "0.45rem", lineHeight: 1.65, color: "var(--text)" }}>
              {error.friendly}
            </div>
            {error.raw !== error.friendly && (
              <div style={{ marginTop: "0.6rem" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowRaw((v) => !v)}
                  style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", color: "var(--faint)" }}
                >
                  {showRaw ? "Hide" : "Show"} raw error
                </button>
                {showRaw && (
                  <pre
                    className="mono"
                    style={{
                      marginTop: "0.5rem",
                      fontSize: "0.68rem",
                      color: "var(--faint)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      lineHeight: 1.5,
                      maxHeight: 180,
                      overflowY: "auto",
                      background: "rgba(0,0,0,0.2)",
                      padding: "0.6rem",
                      borderRadius: "calc(var(--radius) - 2px)",
                    }}
                  >
                    {error.raw}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        {stage === "confirmed" && (
          <div
            className="reveal"
            style={{
              marginTop: "1.5rem",
              padding: "1.25rem",
              borderRadius: "var(--radius)",
              background: "rgba(62,207,142,0.07)",
              border: "1px solid rgba(62,207,142,0.2)",
              display: "flex",
              alignItems: "center",
              gap: "1rem",
            }}
          >
            <Check size={44} run />
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>Proof verified on-chain</div>
              <div className="muted" style={{ fontSize: "0.8375rem", marginTop: "0.25rem", lineHeight: 1.5 }}>
                Your claim is live on Stellar for {Math.round(credTtlSecs(cred) / 86_400)} days — without revealing the data behind it.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── ProofStep ─────────────────────────────────────────────────────────────────

function ProofStep({
  icon,
  title,
  subtitle,
  state,
  detail,
  last = false,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  state: "idle" | "active" | "done";
  detail?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: "0.85rem", alignItems: "flex-start" }}>
      {/* left: connector */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 28, flexShrink: 0 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            border: `1px solid ${
              state === "done"   ? "var(--accent)" :
              state === "active" ? "rgba(62,207,142,0.5)" :
                                   "var(--border-strong)"
            }`,
            background: state === "done" ? "var(--accent)" : "transparent",
            color: state === "done" ? "var(--bg)" : state === "active" ? "var(--accent)" : "var(--faint)",
            transition: "all 0.35s var(--ease)",
          }}
        >
          {state === "done" ? (
            <IconCheck size={13} stroke={3} />
          ) : state === "active" ? (
            <IconLoader2 size={13} className="spin" />
          ) : (
            icon
          )}
        </div>
        {!last && (
          <div
            style={{
              width: 1,
              flex: 1,
              minHeight: 20,
              marginTop: 4,
              background: state === "done" ? "var(--accent)" : "var(--border)",
              transition: "background 0.4s var(--ease)",
              opacity: state === "done" ? 0.4 : 1,
            }}
          />
        )}
      </div>

      {/* right: text */}
      <div style={{ paddingBottom: last ? 0 : "1.25rem", flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", paddingTop: "0.3rem" }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: "0.875rem",
              color: state === "idle" ? "var(--muted)" : "var(--text)",
              transition: "color 0.25s var(--ease)",
            }}
          >
            {title}
          </span>
          {state === "active" && (
            <span
              style={{
                fontSize: "0.68rem",
                color: "var(--accent)",
                background: "rgba(62,207,142,0.1)",
                border: "1px solid rgba(62,207,142,0.2)",
                borderRadius: "999px",
                padding: "0.1rem 0.45rem",
                fontWeight: 500,
              }}
            >
              running
            </span>
          )}
        </div>
        <div style={{ fontSize: "0.75rem", color: "var(--faint)", marginTop: "0.1rem" }}>
          {subtitle}
        </div>
        {detail}
      </div>
    </div>
  );
}

// ── Small utilities ───────────────────────────────────────────────────────────

function AnimatedDots({ text, style }: { text: string; style?: React.CSSProperties }) {
  const [dots, setDots] = useState(".");
  useEffect(() => {
    const id = setInterval(() => setDots((d) => d.length >= 3 ? "." : d + "."), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ fontSize: "0.8rem", color: "var(--muted)", ...style }}>
      {text}
      <span style={{ color: "var(--accent)" }}>{dots}</span>
    </span>
  );
}

function ProvingBar() {
  return (
    <div
      style={{
        height: "3px",
        borderRadius: "999px",
        background: "var(--bg-soft)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(90deg, transparent 0%, var(--accent) 50%, transparent 100%)",
          width: "50%",
          animation: "proving-shimmer 1.6s ease-in-out infinite",
        }}
      />
      <style>{`
        @keyframes proving-shimmer {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(300%); }
        }
      `}</style>
    </div>
  );
}

function toHex(u8: Uint8Array): string {
  return Array.from(u8.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
