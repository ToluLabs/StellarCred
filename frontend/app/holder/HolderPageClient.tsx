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
const CredentialDetailModal = dynamic(
  () => import("@/components/CredentialDetailModal"),
  { ssr: false },
);

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

      {confirmBulkAction && (
        <BulkRemoveModal
          type={confirmBulkAction.type}
          count={confirmBulkAction.commitments.length}
          onCancel={() => setConfirmBulkAction(null)}
          onConfirm={() => executeBulkRemove(confirmBulkAction.commitments)}
        />
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
