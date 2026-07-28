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
  IconStack2,
} from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";
import { useWallet } from "@/lib/wallet-context";
import { Badge } from "@/components/Badge";
import { Check } from "@/components/Check";
import { ConfigBanner } from "@/components/ConfigBanner";
import { NetworkMismatchBanner } from "@/components/NetworkMismatchBanner";
import { truncateHash } from "@/lib/format";
import { EXPLORER_TX } from "@/lib/stellar";
import { computeWitness, proveWithBackend } from "@/lib/proof";
import {
  submitProof,
  submitProofsBatch,
  parseContractError,
  type ContractError,
  type ProofSubmissionParams,
} from "@/lib/contracts";
import {
  type Credential,
  loadCredentials,
  saveCredential,
  removeCredential,
  markProved,
  markAllProved,
  parseCredential,
} from "@/lib/credential";
import { PREVIEW_CREDENTIALS } from "@/lib/preview-fixtures";
import { usePreviewMode } from "@/lib/wallet-context";
import CopyButton from "@/components/CopyButton";
import { useToast } from "@/components/Toast";

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
  isPreview,
}: {
  c: Credential;
  address: string;
  onProve: () => void;
  onRemove: () => void;
  isPreview?: boolean;
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
        <div className="card-actions">
          {isPreview && <Badge variant="pending">Preview</Badge>}
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

type PageView =
  | { kind: "list" }
  | { kind: "single"; cred: Credential }
  | { kind: "batch"; creds: Credential[] };

export default function HolderPage() {
  const { address, connect } = useWallet();
  const isPreview = usePreviewMode();
  const [creds, setCreds] = useState<Credential[]>([]);
  const [view, setView] = useState<PageView>({ kind: "list" });
  const [importing, setImporting] = useState(false);

  useEffect(() => setCreds(loadCredentials()), []);

  const displayCreds = isPreview ? PREVIEW_CREDENTIALS : creds;
  const unproved = displayCreds.filter((c) => proofStatus(c) !== "proved");
  const proved   = displayCreds.filter((c) => proofStatus(c) === "proved");

  // Credentials eligible for "Prove all" (unproved or expired), capped at 5.
  // Deduplicate by type: the contract writes one slot per (holder, credential_type),
  // so two entries of the same type in a batch would silently overwrite each other.
  const batchCandidates = unproved
    .filter((c, idx, arr) => arr.findIndex((x) => x.type === c.type) === idx)
    .slice(0, 5);
  const canBatch = address && batchCandidates.length >= 2;

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

      {isPreview && (
        <div
          style={{
            padding: "0.85rem 1rem",
            borderRadius: "var(--radius)",
            background: "rgba(62,207,142,0.1)",
            border: "1px solid rgba(62,207,142,0.3)",
            color: "var(--text)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "1.5rem",
          }}
        >
          <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>
            Connect wallet to use your real credentials
          </span>
          <button className="btn btn-primary btn-sm" onClick={connect}>
            Connect Wallet
          </button>
        </div>
      )}

      {view.kind === "single" ? (

        <ProofFlow
          cred={view.cred}
          holder={address}
          onBack={() => setView({ kind: "list" })}
          onProved={(txHash) => setCreds(markProved(view.cred.commitment, txHash))}
        />
      ) : view.kind === "batch" ? (
        <BatchProofFlow
          creds={view.creds}
          holder={address}
          onBack={() => setView({ kind: "list" })}
          onProved={(txHash, commitments) => setCreds(markAllProved(commitments, txHash))}
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
                  onProve={() => setView({ kind: "single", cred: c })}
                  onRemove={() => setCreds(removeCredential(c.commitment))}
                  isPreview={isPreview}
                />
              ))}

              {/* Prove all button — shown when there are 2+ unproved credentials */}
              {canBatch && (
                <button
                  id="prove-all-btn"
                  className="btn btn-primary"
                  style={{
                    alignSelf: "flex-start",
                    marginTop: "0.25rem",
                    gap: "0.45rem",
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                  onClick={() => setView({ kind: "batch", creds: batchCandidates })}
                >
                  <IconStack2 size={15} />
                  Prove all ({batchCandidates.length}) in one transaction
                </button>
              )}
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
                  onProve={() => setView({ kind: "single", cred: c })}
                  onRemove={() => setCreds(removeCredential(c.commitment))}
                  isPreview={isPreview}
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
  const toast = useToast();
  const { networkMismatch } = useWallet();

  useEffect(() => {
    let cancelled = false;
    toast.info(`Generating proof for ${cred.title}…`);
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
        toast.success(`Proof generated for ${cred.title}`);
      } catch (e) {
        clearInterval(timerRef.current!);
        if (!cancelled) {
          const parsed = parseContractError((e as Error).message);
          setError(parsed);
          setStage("error");
          toast.error(`Proof generation failed: ${parsed.friendly}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(timerRef.current!);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cred]);

  async function onSubmit() {
    if (!proof || networkMismatch) return;
    setStage("submitting");
    toast.info(`Submitting proof for ${cred.title} to Stellar…`);
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
      toast.success(`Proof confirmed on-chain for ${cred.title}`, { txHash: hash });
    } catch (e) {
      const parsed = parseContractError((e as Error).message);
      setError(parsed);
      setStage("error");
      toast.error(`Submission failed: ${parsed.friendly}`);
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
                <div
                  className="row"
                  style={{ gap: "0.5rem", marginTop: "0.3rem", alignItems: "center" }}
                >
                  <a
                    href={EXPLORER_TX(txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="row accent"
                    style={{ gap: "0.3rem", fontSize: "0.775rem" }}
                  >
                    {txHash.slice(0, 8)}...{txHash.slice(-6)}
                    <IconExternalLink size={12} />
                  </a>
                  <CopyButton value={txHash} />
                </div>
              ) : null
            }
          />
        </div>

        {/* CTA */}
        {stage === "generated" && (
          <>
            {networkMismatch && (
              <div style={{ marginTop: "1.5rem" }}>
                <NetworkMismatchBanner />
              </div>
            )}
            <button
              className="btn btn-primary"
              style={{
                marginTop: networkMismatch ? 0 : "1.5rem",
                width: "100%",
                opacity: networkMismatch ? 0.5 : 1,
                cursor: networkMismatch ? "not-allowed" : "pointer",
              }}
              onClick={onSubmit}
              disabled={networkMismatch}
              title={networkMismatch ? "Switch your wallet to the correct network to submit" : undefined}
            >
              Submit to Stellar
              <IconArrowRight size={15} />
            </button>
          </>
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

// ── BatchProofFlow ────────────────────────────────────────────────────────────

/** State of one credential's local proving steps. */
type CredProofState =
  | { status: "pending" }
  | { status: "witness" }
  | { status: "proving"; elapsed: number }
  | { status: "ready"; proof: { proof: Uint8Array; publicInputs: Uint8Array } }
  | { status: "error"; message: string };

type BatchStage = "generating" | "submitting" | "confirmed" | "error";

function BatchProofFlow({
  creds,
  holder,
  onBack,
  onProved,
}: {
  creds: Credential[];
  holder: string;
  onBack: () => void;
  onProved: (txHash: string, commitments: string[]) => void;
}) {
  const [credStates, setCredStates] = useState<CredProofState[]>(
    () => creds.map(() => ({ status: "pending" as const })),
  );
  const [batchStage, setBatchStage] = useState<BatchStage>("generating");
  const [txHash, setTxHash] = useState("");
  const [batchError, setBatchError] = useState<ContractError | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const toast = useToast();
  const { networkMismatch } = useWallet();
  const generatedProofs = useRef<Array<{ proof: Uint8Array; publicInputs: Uint8Array } | null>>(
    creds.map(() => null),
  );
  // Stable refs so the submission effect always reads the latest values
  // even if the parent re-renders between proof generation and submission.
  const credsRef = useRef(creds);
  const holderRef = useRef(holder);
  useEffect(() => { credsRef.current = creds; }, [creds]);
  useEffect(() => { holderRef.current = holder; }, [holder]);

  // Generate proofs for all credentials in sequence.
  useEffect(() => {
    let cancelled = false;
    toast.info(`Generating ${creds.length} proofs…`);

    (async () => {
      for (let i = 0; i < creds.length; i++) {
        if (cancelled) return;
        const cred = creds[i];

        // Witness
        setCredStates((prev) => {
          const next = [...prev];
          next[i] = { status: "witness" };
          return next;
        });

        let witness: Uint8Array;
        try {
          witness = await computeWitness(cred.type, cred as unknown as Record<string, unknown>);
        } catch (e) {
          if (cancelled) return;
          setCredStates((prev) => {
            const next = [...prev];
            next[i] = { status: "error", message: (e as Error).message };
            return next;
          });
          setBatchStage("error");
          const parsed = parseContractError((e as Error).message);
          setBatchError(parsed);
          toast.error(`Proof generation failed for ${cred.title}: ${parsed.friendly}`);
          return;
        }

        if (cancelled) return;

        // Proving
        const start = Date.now();
        const timer = setInterval(() => {
          setCredStates((prev) => {
            const next = [...prev];
            if (next[i].status === "proving") {
              next[i] = { status: "proving", elapsed: Math.floor((Date.now() - start) / 1000) };
            }
            return next;
          });
        }, 1000);
        setCredStates((prev) => {
          const next = [...prev];
          next[i] = { status: "proving", elapsed: 0 };
          return next;
        });

        let result: { proof: Uint8Array; publicInputs: Uint8Array };
        try {
          result = await proveWithBackend(cred.type, witness);
        } catch (e) {
          clearInterval(timer);
          if (cancelled) return;
          setCredStates((prev) => {
            const next = [...prev];
            next[i] = { status: "error", message: (e as Error).message };
            return next;
          });
          setBatchStage("error");
          const parsed = parseContractError((e as Error).message);
          setBatchError(parsed);
          toast.error(`Proof generation failed for ${cred.title}: ${parsed.friendly}`);
          return;
        }

        clearInterval(timer);
        if (cancelled) return;

        generatedProofs.current[i] = result;
        setCredStates((prev) => {
          const next = [...prev];
          next[i] = { status: "ready", proof: result };
          return next;
        });
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // All proofs ready — fire the batch submission automatically, but never
  // while the connected wallet is on the wrong network: submission would
  // fail after the (expensive) proofs are already generated. Once ready,
  // this effect re-fires the moment `networkMismatch` clears — no separate
  // retry button needed, matching this flow's fully-automatic submission.
  const allReady =
    batchStage === "generating" &&
    credStates.length > 0 &&
    credStates.every((s) => s.status === "ready");
  const blockedByNetwork = allReady && networkMismatch;

  useEffect(() => {
    if (!allReady || networkMismatch) return;
    toast.success(`Generated ${creds.length} proofs`);
    setBatchStage("submitting");

    const currentCreds = credsRef.current;
    const currentHolder = holderRef.current;
    const submissions: ProofSubmissionParams[] = currentCreds.map((cred, i) => {
      const p = generatedProofs.current[i]!;
      return {
        issuerId: cred.issuerId,
        credentialType: cred.type,
        proof: p.proof,
        publicInputs: p.publicInputs,
        ttlSecs: credTtlSecs(cred),
      };
    });

    toast.info(`Submitting ${currentCreds.length} proofs to Stellar…`);
    submitProofsBatch({ holder: currentHolder, submissions })
      .then((hash) => {
        setTxHash(hash);
        setBatchStage("confirmed");
        onProved(hash, currentCreds.map((c) => c.commitment));
        toast.success(`All ${currentCreds.length} proofs confirmed on-chain`, { txHash: hash });
      })
      .catch((e) => {
        const parsed = parseContractError((e as Error).message);
        setBatchError(parsed);
        setBatchStage("error");
        toast.error(`Batch submission failed: ${parsed.friendly}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allReady, networkMismatch, onProved]);

  const isSubmitting = batchStage === "submitting";
  const isConfirmed = batchStage === "confirmed";
  const isError = batchStage === "error";

  return (
    <div className="reveal" style={{ maxWidth: 560, margin: "0 auto" }}>
      <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: "1.5rem" }}>
        <IconArrowLeft size={14} />
        All credentials
      </button>

      <div className="card" style={{ padding: "1.75rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <span className="eyebrow" style={{ marginBottom: "0.5rem", display: "block" }}>
            Batch proving
          </span>
          <h2 style={{ marginBottom: "0.25rem" }}>
            Prove all {creds.length} credentials
          </h2>
          <span className="faint" style={{ fontSize: "0.8rem" }}>
            Proofs are generated in your browser, then submitted in a single on-chain transaction.
          </span>
        </div>

        {/* Per-credential progress rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "1.5rem" }}>
          {creds.map((cred, i) => {
            const cs = credStates[i] ?? { status: "pending" };
            return (
              <BatchCredRow
                key={cred.commitment}
                cred={cred}
                state={cs}
                isLast={i === creds.length - 1}
              />
            );
          })}
        </div>

        {/* Submission step */}
        <ProofStep
          icon={<IconCloudUpload size={14} stroke={1.8} />}
          title="Submit batch to Stellar"
          subtitle={`ProofRegistry.submit_proofs_batch · ${creds.length} credentials · single Freighter signature`}
          state={
            isSubmitting ? "active" :
            isConfirmed  ? "done"   : "idle"
          }
          last
          detail={
            isSubmitting ? (
              <AnimatedDots text="Writing all proofs to ProofRegistry" style={{ marginTop: "0.35rem" }} />
            ) : isConfirmed ? (
              <div
                className="row"
                style={{ gap: "0.5rem", marginTop: "0.3rem", alignItems: "center" }}
              >
                <a
                  href={EXPLORER_TX(txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="row accent"
                  style={{ gap: "0.3rem", fontSize: "0.775rem" }}
                >
                  {txHash.slice(0, 8)}...{txHash.slice(-6)}
                  <IconExternalLink size={12} />
                </a>
                <CopyButton value={txHash} />
              </div>
            ) : null
          }
        />

        {/* Network mismatch — proofs are ready but submission is blocked */}
        {blockedByNetwork && (
          <div style={{ marginTop: "1.5rem" }}>
            <NetworkMismatchBanner />
          </div>
        )}

        {/* Error banner */}
        {isError && batchError && (
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
              {batchError.code !== null ? `Contract error #${batchError.code}` : "Batch failed"}
            </div>
            <div style={{ fontSize: "0.8125rem", marginTop: "0.45rem", lineHeight: 1.65, color: "var(--text)" }}>
              {batchError.friendly}
            </div>
            {batchError.raw !== batchError.friendly && (
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
                    {batchError.raw}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        {/* Confirmed success banner */}
        {isConfirmed && (
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
              <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>
                All {creds.length} proofs verified on-chain
              </div>
              <div className="muted" style={{ fontSize: "0.8375rem", marginTop: "0.25rem", lineHeight: 1.5 }}>
                Every credential is now live on Stellar — submitted in a single transaction.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── BatchCredRow ──────────────────────────────────────────────────────────────

function BatchCredRow({
  cred,
  state,
  isLast,
}: {
  cred: Credential;
  state: CredProofState;
  isLast: boolean;
}) {
  const isPending = state.status === "pending";
  const isWitness = state.status === "witness";
  const isProving = state.status === "proving";
  const isReady   = state.status === "ready";
  const isErr     = state.status === "error";

  const stepState: "idle" | "active" | "done" =
    isReady ? "done" :
    isProving || isWitness ? "active" :
    isErr ? "idle" :
    "idle";

  const detail = isWitness ? (
    <AnimatedDots text="Computing witness" style={{ marginTop: "0.25rem" }} />
  ) : isProving ? (
    <div style={{ marginTop: "0.35rem", display: "flex", flexDirection: "column", gap: "0.3rem" }}>
      <ProvingBar />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: "0.72rem", color: "var(--muted)" }}>Generating proof in browser…</span>
        <span className="mono" style={{ fontSize: "0.7rem", color: "var(--faint)" }}>
          {(state as { status: "proving"; elapsed: number }).elapsed}s
        </span>
      </div>
    </div>
  ) : isReady ? (
    <div style={{ marginTop: "0.2rem" }}>
      <span className="mono" style={{ fontSize: "0.72rem", color: "var(--accent)" }}>
        π {truncateHash("0x" + toHex((state as { status: "ready"; proof: { proof: Uint8Array; publicInputs: Uint8Array } }).proof.proof))}
      </span>
      <span className="mono faint" style={{ fontSize: "0.7rem", marginLeft: "0.4rem" }}>
        {(state as { status: "ready"; proof: { proof: Uint8Array; publicInputs: Uint8Array } }).proof.proof.length.toLocaleString()} bytes
      </span>
    </div>
  ) : isErr ? (
    <span style={{ fontSize: "0.72rem", color: "var(--danger)", marginTop: "0.2rem", display: "block" }}>
      {(state as { status: "error"; message: string }).message.slice(0, 80)}
    </span>
  ) : null;

  const icon =
    isPending ? <span style={{ fontSize: "0.65rem", color: "var(--faint)" }}>{cred.type.slice(0, 3)}</span> :
    isErr     ? <IconAlertTriangle size={13} /> :
                <IconCpu size={13} stroke={1.8} />;

  return (
    <ProofStep
      icon={icon}
      title={cred.title}
      subtitle={cred.claim}
      state={stepState}
      detail={detail}
      last={isLast}
    />
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
