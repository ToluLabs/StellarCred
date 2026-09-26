"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import {
  IconArrowRight,
  IconPlus,
  IconAlertTriangle,
  IconCertificate,
  IconDownload,
} from "@tabler/icons-react";

import { WalletButton } from "@/components/WalletButton";
import { useWallet, usePreviewMode } from "@/lib/wallet-context";
import { ConfigBanner } from "@/components/ConfigBanner";
import { useWarmProver } from "@/lib/use-warm-prover";
import { type Credential } from "@/lib/credential";
import { PREVIEW_CREDENTIALS } from "@/lib/preview-fixtures";
import { useToast } from "@/components/Toast";
import { IMPORT_PARAM } from "@/lib/transfer";
import { proofStatus, isExpiringSoon, daysRemaining } from "@/lib/proof-helpers";

import { useCredentialStore } from "@/lib/hooks/useCredentialStore";
import { useBatchSelection } from "@/lib/hooks/useBatchSelection";
import { useImportExport } from "@/lib/hooks/useImportExport";

import { CredCard } from "@/components/holder/CredCard";
import { SectionLabel } from "@/components/holder/SectionLabel";
import { BatchBar } from "@/components/holder/BatchBar";
import { ImportPanel } from "@/components/holder/ImportPanel";
import { ProofFlowView } from "@/components/holder/ProofFlowView";
import { BatchProofFlowView } from "@/components/holder/BatchProofFlowView";
import { GuardianRecoveryControl } from "@/components/holder/GuardianRecoveryControl";
import { BulkRemoveModal } from "@/components/holder/BulkRemoveModal";

const TransferExportModal = dynamic(
  () => import("@/components/TransferExportModal").then((m) => m.TransferExportModal),
  { ssr: false },
);
const TransferImportModal = dynamic(
  () => import("@/components/TransferImportModal").then((m) => m.TransferImportModal),
  { ssr: false },
);

// Parse "90 days", "30 days" etc from the credential's expiry string.
function credTtlSecs(cred: Credential): number {
  const match = cred.expiry?.match(/(\d+)/);
  return (match ? parseInt(match[1]) : 30) * 86_400;
}

// Downloads every locally stored credential as a JSON backup file. Pairs with
// the "Import credential JSON" panel: the file's contents can be pasted back
// here (or into another browser/device) to restore. Credentials live only in
// this browser&apos;s localStorage, so this is the only backup path — see the
// "Where your credentials live" docs section.
async function downloadBackup(): Promise<void> {
  const json = await exportCredentials();
  if (!json || json === "[]") return;
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stellarcred-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function proofStatus(cred: Credential): "unproved" | "proved" | "expired" {
  if (!cred.provedAt) return "unproved";
  return cred.provedAt + credTtlSecs(cred) > Math.floor(Date.now() / 1000)
    ? "proved"
    : "expired";
}

function isExpiringSoon(cred: Credential, windowDays = 7): boolean {
  if (!cred.provedAt) return false;
  const now = Math.floor(Date.now() / 1000);
  const expiry = cred.provedAt + credTtlSecs(cred);
  return expiry > now && expiry <= now + windowDays * 86_400;
}

function daysRemaining(cred: Credential): number {
  if (!cred.provedAt) return 0;
  const secsLeft = cred.provedAt + credTtlSecs(cred) - Math.floor(Date.now() / 1000);
  return Math.max(0, Math.ceil(secsLeft / 86_400));
}

import { useProofTimeline, addTimelineEvent } from "@/lib/useProofTimeline";
import { Timeline } from "@/components/Timeline";
import { IconHistory } from "@tabler/icons-react";

// ── Credential expiry helpers ─────────────────────────────────────────────────

function credExpiryTimestamp(cred: Credential): number {
  return cred.issuedAt + credTtlSecs(cred);
}

function credIsExpired(cred: Credential): boolean {
  return credExpiryTimestamp(cred) <= Math.floor(Date.now() / 1000);
}

function credExpiryWithinDays(cred: Credential, days: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const ts = credExpiryTimestamp(cred);
  return ts > now && ts <= now + days * 86_400;
}

function formatExpiryDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ── Credential card ──────────────────────────────────────────────────────────

function CredCard({
  c,
  address,
  onProve,
  onRemove,
  onInspect: _onInspect,
  isPreview,
  selection: _selection,
}: {
  c: Credential;
  address: string;
  onProve: () => void;
  onRemove: () => void;
  onInspect: () => void;
  isPreview?: boolean;
  /** Batch selection controls — omitted on cards that can&apos;t be batched. */
  selection?: {
    checked: boolean;
    /** Why this card can&apos;t currently be added, or null when it can. */
    blockedReason: string | null;
    onToggle: () => void;
  };
}) {
  const status = proofStatus(c);
  const { events } = useProofTimeline(c);
  const [showHistory, setShowHistory] = useState(false);

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
            <div>
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
            <div style={{ marginTop: "0.1rem" }}>
              {credIsExpired(c) ? (
                <span style={{ color: "var(--danger)", fontWeight: 500 }}>Expired</span>
              ) : (
                <span style={{ color: credExpiryWithinDays(c, 30) ? "var(--warn)" : "var(--faint)" }}>
                  Expires {formatExpiryDate(credExpiryTimestamp(c))}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* right: badges + button + trash */}
        <div className="card-actions">
          {isPreview && <Badge variant="pending">Preview</Badge>}
          <Badge variant="verified" dot={false}>Held</Badge>
          {status === "proved" && !isExpiringSoon(c) && (
            <Badge variant="verified" dot={false}>On-chain</Badge>
          )}
          {status === "proved" && isExpiringSoon(c) && (
            <Badge variant="pending" dot={true}>Expiring in {daysRemaining(c)}d</Badge>
          )}
          {status === "expired" && (
            <Badge variant="denied" dot={true}>Proof Expired</Badge>
          )}
          <button
            className={`btn btn-sm ${status === "proved" ? "btn-secondary" : "btn-primary"}`}
            disabled={!address || credIsExpired(c) || !proofSubmissionConfigured()}
            title={
              !address
                ? "Connect a wallet first"
                : credIsExpired(c)
                  ? "This credential has expired"
                  : !proofSubmissionConfigured()
                    ? "App not configured — NEXT_PUBLIC_PROOF_REGISTRY_ID missing"
                    : undefined
            }
            onClick={onProve}
          >
            {status === "proved"  ? "Re-prove" :
             status === "expired" ? "Re-prove" :
                                    "Generate proof"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="History"
            onClick={() => setShowHistory(!showHistory)}
            style={{ padding: "0.3rem 0.4rem", color: showHistory ? "var(--accent)" : "var(--faint)" }}
          >
            <IconHistory size={13} />
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
      
      {showHistory && (
        <Timeline events={events} />
      )}
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

function HolderInner() {
  const { address, connect } = useWallet();
  const isPreview = usePreviewMode();
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();

  const { creds, reload, save, remove, markCredentialProved, markCredentialsProved } = useCredentialStore();
  const { downloadBackup } = useImportExport();

  const [view, setView] = useState<PageView>({ kind: "list" });
  const [importing, setImporting] = useState(false);
  const [detailCred, setDetailCred] = useState<Credential | null>(null);
  const [transferCred, setTransferCred] = useState<Credential | null>(null);
  const [importPayload, setImportPayload] = useState<string | null>(null);

  useEffect(() => {
    const payload = searchParams.get(IMPORT_PARAM);
    if (!payload) return;
    setImportPayload(payload);
    router.replace("/holder");
  }, [searchParams, router]);

  const displayCreds = isPreview ? PREVIEW_CREDENTIALS : creds;
  const unproved = displayCreds.filter((c) => proofStatus(c) === "unproved");
  const expiringSoon = displayCreds
    .filter((c) => proofStatus(c) === "proved" && isExpiringSoon(c, 7))
    .sort((a, b) => daysRemaining(a) - daysRemaining(b));
  const activeProved = displayCreds.filter((c) => proofStatus(c) === "proved" && !isExpiringSoon(c, 7));
  const expired = displayCreds.filter((c) => proofStatus(c) === "expired");

  const unprovedTypes = Array.from(new Set(unproved.map((c) => c.type)));
  useWarmProver(unprovedTypes, Boolean(address));

  const {
    selectedCommitments,
    selectedCreds,
    atBatchLimit,
    canBatch,
    canSubmitBatch,
    blockedReason,
    toggleSelected,
    selectEligible,
    clearSelection,
  } = useBatchSelection(unproved, address, (msg) => toast.error(msg));

  const [confirmBulkAction, setConfirmBulkAction] = useState<{
    type: "remove-selected" | "clear-expired";
    commitments: string[];
  } | null>(null);

  async function executeBulkRemove(commitments: string[]) {
    for (const commitment of commitments) {
      await remove(commitment);
    }
    clearSelection();
    setConfirmBulkAction(null);
  }

  return (
    <>
      <div className="between" style={{ marginBottom: "2.5rem" }}>
        <div>
          <span className="eyebrow">Holder</span>
          <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>Your credentials</h1>
        </div>
        <div className="row" style={{ gap: "0.75rem" }}>
          <a href="/presets" className="btn btn-secondary">
            Presets
          </a>
          <WalletButton />
        </div>
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
        <ProofFlowView
          cred={view.cred}
          holder={address}
          onBack={() => setView({ kind: "list" })}
          onProved={(txHash) => markCredentialProved(view.cred.commitment, txHash)}
        />
      ) : view.kind === "batch" ? (
        <BatchProofFlowView
          creds={view.creds}
          holder={address}
          onBack={() => setView({ kind: "list" })}
          onProved={(txHash, commitments) => markCredentialsProved(commitments, txHash)}
        />
      ) : (
        <div className="stack reveal" style={{ gap: "1.5rem" }}>
          {/* Expiry Warning Banner */}
          {(expiringSoon.length > 0 || expired.length > 0) && (
            <div
              role="status"
              aria-live="polite"
              className="card"
              style={{
                padding: "0.85rem 1.15rem",
                backgroundColor: expired.length > 0 ? "rgba(239, 68, 68, 0.08)" : "rgba(234, 179, 8, 0.08)",
                borderColor: expired.length > 0 ? "rgba(239, 68, 68, 0.3)" : "rgba(234, 179, 8, 0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
                flexWrap: "wrap",
              }}
            >
              <div className="row" style={{ gap: "0.6rem", alignItems: "center" }}>
                <IconAlertTriangle
                  size={18}
                  style={{ color: expired.length > 0 ? "var(--danger)" : "var(--warn)", flexShrink: 0 }}
                />
                <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>
                  {expired.length > 0
                    ? `${expired.length} proof${expired.length > 1 ? "s have" : " has"} expired and ${expired.length > 1 ? "need" : "needs"} re-proving.`
                    : `${expiringSoon.length} proof${expiringSoon.length > 1 ? "s are" : " is"} expiring within 7 days.`}
                </span>
              </div>
              <span className="mono faint" style={{ fontSize: "0.75rem" }}>
                One-click re-prove available below
              </span>
            </div>
          )}

          {/* Empty state */}
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
              <p
                className="faint"
                style={{ fontSize: "0.75rem", maxWidth: 380, margin: "1.25rem auto 0", lineHeight: 1.6 }}
              >
                Credentials are stored only in this browser&apos;s local storage — clearing
                site data, switching browsers/devices, or private mode erases them.{" "}
                <Link
                  href="/docs#storage"
                  style={{ color: "var(--accent)", textDecoration: "underline" }}
                >
                  Where your credentials live
                </Link>
              </p>
            </div>
          )}

          {/* Expiring soon */}
          {expiringSoon.length > 0 && (
            <div className="stack" style={{ gap: "0.6rem" }}>
              <SectionLabel>Expiring soon · Re-prove recommended</SectionLabel>
              {expiringSoon.map((c) => (
                <CredCard
                  key={c.commitment}
                  c={c}
                  address={address}
                  onProve={() => setView({ kind: "single", cred: c })}
                  onRemove={() => remove(c.commitment)}
                  onInspect={() => setDetailCred(c)}
                  isPreview={isPreview}
                />
              ))}
            </div>
          )}

          {/* Expired */}
          {expired.length > 0 && (
            <div className="stack" style={{ gap: "0.6rem" }}>
              <SectionLabel>Expired proofs · Re-prove required</SectionLabel>
              <div
                className="between"
                style={{
                  marginBottom: "1rem",
                  padding: "0.75rem 1rem",
                  background: "rgba(239, 68, 68, 0.1)",
                  border: "1px solid rgba(239, 68, 68, 0.2)",
                  borderRadius: "8px",
                  alignItems: "center",
                }}
              >
                <span className="faint" style={{ fontSize: "0.85rem", color: "#fca5a5" }}>
                  {expired.length} expired credential{expired.length > 1 ? "s" : ""}
                </span>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ color: "#ef4444", borderColor: "rgba(239, 68, 68, 0.3)" }}
                  onClick={() =>
                    setConfirmBulkAction({
                      type: "clear-expired",
                      commitments: expired.map((c) => c.commitment),
                    })
                  }
                >
                  Clear all expired
                </button>
              </div>
              {expired.map((c) => (
                <CredCard
                  key={c.commitment}
                  c={c}
                  address={address}
                  onProve={() => setView({ kind: "single", cred: c })}
                  onRemove={() => remove(c.commitment)}
                  onInspect={() => setDetailCred(c)}
                  isPreview={isPreview}
                />
              ))}
            </div>
          )}

          {/* Ready to prove */}
          {unproved.length > 0 && (
            <div className="stack" style={{ gap: "0.6rem" }}>
              <SectionLabel>Ready to prove</SectionLabel>
              {unproved.map((c) => (
                <CredCard
                  key={c.commitment}
                  c={c}
                  address={address}
                  onProve={() => setView({ kind: "single", cred: c })}
                  onRemove={() => remove(c.commitment)}
                  onInspect={() => setDetailCred(c)}
                  isPreview={isPreview}
                  selection={
                    canBatch
                      ? {
                          checked: selectedCommitments.includes(c.commitment),
                          blockedReason: blockedReason(c),
                          onToggle: () => toggleSelected(c),
                        }
                      : undefined
                  }
                />
              ))}

              {canBatch && (
                <BatchBar
                  selectedCount={selectedCreds.length}
                  atBatchLimit={atBatchLimit}
                  canSubmitBatch={canSubmitBatch}
                  onProveBatch={() => setView({ kind: "batch", creds: selectedCreds })}
                  onClear={clearSelection}
                  onSelectEligible={selectEligible}
                  onRemoveSelected={() =>
                    setConfirmBulkAction({
                      type: "remove-selected",
                      commitments: selectedCommitments,
                    })
                  }
                />
              )}
            </div>
          )}

          {/* Active proved */}
          {activeProved.length > 0 && (
            <div className="stack" style={{ gap: "0.6rem" }}>
              <SectionLabel>On-chain · active proofs</SectionLabel>
              {activeProved.map((c) => (
                <CredCard
                  key={c.commitment}
                  c={c}
                  address={address}
                  onProve={() => setView({ kind: "single", cred: c })}
                  onRemove={() => remove(c.commitment)}
                  onInspect={() => setDetailCred(c)}
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
              onImport={async (c) => {
                await save(c);
                setImporting(false);
              }}
              onCancel={() => setImporting(false)}
            />
          ) : (
            <div className="stack" style={{ gap: "0.55rem" }}>
              <div className="row" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setImporting(true)}
                >
                  <IconPlus size={14} />
                  Import credential JSON
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={downloadBackup}
                  disabled={creds.length === 0}
                  title={creds.length === 0 ? "No credentials to back up yet" : "Download a JSON backup of all credentials"}
                >
                  <IconDownload size={14} />
                  Export backup
                </button>
                <GuardianRecoveryControl
                  hasCredentials={creds.length > 0}
                  onRestored={() => reload()}
                />
              </div>
              <p className="faint" style={{ fontSize: "0.75rem", maxWidth: 560, lineHeight: 1.6, margin: 0 }}>
                Credentials live only in this browser (localStorage) — export a backup
                before clearing site data or switching devices, and restore it here with{" "}
                “Import credential JSON”.{" "}
                <Link
                  href="/docs#storage"
                  style={{ color: "var(--accent)", textDecoration: "underline" }}
                >
                  Where your credentials live
                </Link>
              </p>
            </div>
          )}
        </div>
      )}

      {detailCred && (
        <CredentialDetailModal
          credential={detailCred}
          onClose={() => setDetailCred(null)}
          onTransfer={(c) => {
            setDetailCred(null);
            setTransferCred(c as Credential);
          }}
        />
      )}

      {transferCred && (
        <TransferExportModal
          cred={transferCred}
          onClose={() => setTransferCred(null)}
        />
      )}

      {importPayload && (
        <TransferImportModal
          payload={importPayload}
          onImported={(c) => {
            save(c);
            setImportPayload(null);
            toast.success(`Imported ${c.title}`);
          }}
          onClose={() => setImportPayload(null)}
        />
      )}

      {/* Destructive Action Confirmation Modal */}
      {confirmBulkAction && (
        <div className="modal-backdrop" style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0, 0, 0, 0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div className="modal-card" style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: "12px", padding: "1.5rem", maxWidth: "420px", width: "90%" }}>
            <h3 style={{ marginTop: 0, fontSize: "1.2rem" }}>
              {confirmBulkAction.type === "clear-expired" ? "Clear Expired Credentials?" : "Remove Selected Credentials?"}
            </h3>
            <p className="faint" style={{ fontSize: "0.9rem", margin: "1rem 0" }}>
              Are you sure you want to remove {confirmBulkAction.commitments.length} credential{confirmBulkAction.commitments.length > 1 ? "s" : ""}? This will permanently remove them from your browser&apos;s encrypted local storage.
            </p>
            <div className="row" style={{ justifyContent: "flex-end", gap: "0.75rem" }}>
              <button
                className="btn btn-secondary"
                onClick={() => setConfirmBulkAction(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                style={{ backgroundColor: "#dc2626", color: "#fff" }}
                onClick={() => executeBulkRemove(confirmBulkAction.commitments)}
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function HolderPageClient() {
  return (
    <Suspense fallback={null}>
      <HolderInner />
    </Suspense>
  );
}
