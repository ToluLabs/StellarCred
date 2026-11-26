"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { IconAlertTriangle, IconDownload, IconFileExport, IconPlus } from "@tabler/icons-react";

import { WalletButton } from "@/components/WalletButton";
import { WalletOnboarding } from "@/components/WalletOnboarding";
import { LedgerGuide } from "@/components/LedgerGuide";
import { OnboardingNudge } from "@/components/OnboardingNudge";
import { ConfigBanner } from "@/components/ConfigBanner";
import { ExportVisibilitySettings } from "@/components/ExportVisibilitySettings";
import CredentialDetailModal from "@/components/CredentialDetailModal";
import { useToast } from "@/components/Toast";
import { useWallet, usePreviewMode } from "@/lib/wallet-context";
import { PREVIEW_CREDENTIALS } from "@/lib/preview-fixtures";
import { removeCredential, type Credential } from "@/lib/credential";
import { useWarmProver } from "@/lib/use-warm-prover";
import { useCredentialStore } from "@/lib/hooks/useCredentialStore";
import { useBatchSelection } from "@/lib/hooks/useBatchSelection";
import { useImportExport } from "@/lib/hooks/useImportExport";
import { useProofApproval } from "@/lib/hooks/useProofApproval";
import { useTransferImportParam } from "@/lib/hooks/useTransferImportParam";
import { useTransferQuery } from "@/lib/hooks/holder/useTransferQuery";
import { useCredentialBuckets } from "@/lib/hooks/useCredentialBuckets";

// ── Components ────────────────────────────────────────────────────────────────
import { CredCard, type BatchSelection } from "@/components/holder/CredCard";
import { CredListSkeleton } from "@/components/holder/CredListSkeleton";
import { SectionLabel } from "@/components/holder/SectionLabel";
import { ImportPanel } from "@/components/holder/ImportPanel";
import { BatchBar } from "@/components/holder/BatchBar";
import { ConfirmRemoveModal } from "@/components/holder/ConfirmRemoveModal";
import { SponsorBanner } from "@/components/holder/SponsorBanner";
import { GuardianRecoveryControl } from "@/components/holder/GuardianRecoveryControl";
import { ProofFlowView } from "@/components/holder/ProofFlowView";
import { BatchProofFlowView } from "@/components/holder/BatchProofFlowView";
import { CredentialExportPanel } from "@/components/holder/CredentialExportPanel";
import { EmptyCredentialsState } from "@/components/holder/EmptyCredentialsState";
import { PreviewWalletBanner } from "@/components/holder/PreviewWalletBanner";
import { AccountPortfolioSwitcher } from "@/components/holder/AccountPortfolioSwitcher";
import {
  getPortfolioAccounts,
  recordConnectedAccount,
  getActivePortfolioAccount,
  setActivePortfolioAccount,
  filterCredentialsByAccount,
  type PortfolioAccount,
} from "@/lib/account-portfolio";

import type { PageView, BulkAction } from "./types";

// The encrypted-transfer modals are heavy (crypto.ts PBKDF2/AES-GCM, QR
// rendering) and only needed when the user actually starts a transfer — load
// them lazily so the holder route's 15 kB bundle budget stays intact.
const TransferExportModal = dynamic(
  () => import("@/components/TransferExportModal").then((m) => m.TransferExportModal),
  { ssr: false },
);
const TransferImportModal = dynamic(
  () => import("@/components/TransferImportModal").then((m) => m.TransferImportModal),
  { ssr: false },
);
const ExportDataModal = dynamic(
  () => import("@/components/ExportDataModal").then((m) => m.ExportDataModal),
  { ssr: false },
);
const DisclosurePreviewModal = dynamic(
  () => import("@/components/holder/DisclosurePreviewModal").then((m) => m.DisclosurePreviewModal),
  { ssr: false },
);

function HolderInner() {
  const { address, walletId, connect, restoring } = useWallet();
  // While a saved wallet is restoring, `address` is briefly empty. Treating that
  // as preview mode flashes demo credentials and banners before swapping in the
  // real list, so hold loading UI until the restore settles.
  const isPreview = usePreviewMode() && !restoring;
  const toast = useToast();

  // ── Credential store ───────────────────────────────────────────────────────
  const { creds, loading, reload, save, remove, markCredentialProved, markCredentialsProved } =
    useCredentialStore();
  // Show placeholders while credentials hydrate — never the "no credentials"
  // empty state, which would then be replaced by a populated list.
  const showSkeleton = loading && !isPreview;

  const { downloadBackup } = useImportExport();

  const [view, setView] = useState<PageView>({ kind: "list" });
  const proofApproval = useProofApproval(setView);
  const [importing, setImporting] = useState(false);
  const [detailCred, setDetailCred] = useState<Credential | null>(null);
  const [transferCred, setTransferCred] = useState<Credential | null>(null);
  const { importPayload, setImportPayload } = useTransferQuery();
  const [showExportModal, setShowExportModal] = useState(false);
  const [confirmBulkAction, setConfirmBulkAction] = useState<BulkAction | null>(null);

  // A transfer QR opened directly (native camera app -> /holder?import=...)
  // lands here with the payload already in the URL — prompt for the
  // passphrase immediately, and strip it from the URL so a refresh or the
  // back button doesn't re-trigger the prompt or leave ciphertext in history.
  useTransferImportParam(setImportPayload);

  // Multi-account portfolio segregation
  const [portfolioAccounts, setPortfolioAccounts] = useState<PortfolioAccount[]>(() =>
    getPortfolioAccounts(),
  );
  const [activeAccountFilter, setActiveAccountFilter] = useState<string | null>(() =>
    getActivePortfolioAccount(),
  );

  // Update known accounts when connected address changes
  useState(() => {
    if (address) {
      const updated = recordConnectedAccount(address);
      setPortfolioAccounts(updated);
    }
  });

  const handleSelectPortfolioAccount = (selectedAddr: string | null) => {
    setActiveAccountFilter(selectedAddr);
    setActivePortfolioAccount(selectedAddr);
  };

  const rawCreds = isPreview ? PREVIEW_CREDENTIALS : creds;
  // Segregate credentials by active account portfolio (without clearing session data)
  const displayCreds = filterCredentialsByAccount(rawCreds, activeAccountFilter);
  const { unproved, expiringSoon, activeProved, expired } = useCredentialBuckets(displayCreds);

  // Warm the UltraHonk backend for whatever credential types the user still
  // needs to prove, in the background, once the wallet is actually connected
  // (never in preview mode — there's nothing real to prove yet). Only the
  // types actually present in `unproved` are warmed, not all seven circuits,
  // to avoid paying wasm-init cost for types the user has no credential for.
  const unprovedTypes = Array.from(new Set(unproved.map((c) => c.type)));
  useWarmProver(unprovedTypes, Boolean(address));

  // Batch selection enforces both on-chain limits (size + one per type) before
  // anything is proved — see useBatchSelection.
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
  } = useBatchSelection(unproved, address, toast.error);

  // Bulk removal is sequential on purpose: removeCredential is a
  // read-modify-write of the whole list, so concurrent calls would race.
  async function executeBulkRemove(commitments: string[]) {
    for (const commitment of commitments) {
      await removeCredential(commitment);
    }
    reload();
    clearSelection();
    setConfirmBulkAction(null);
  }

  /** One credential card — shared by every section below. */
  function renderCred(c: Credential, selection?: BatchSelection) {
    return (
      <CredCard
        key={c.commitment}
        c={c}
        address={address}
        onProve={() => proofApproval.request({ kind: "single", cred: c })}
        onRemove={() => remove(c.commitment)}
        onInspect={() => setDetailCred(c)}
        isPreview={isPreview}
        selection={selection}
      />
    );
  }

  return (
    <>
      <div className="between" style={{ marginBottom: "2.5rem" }}>
        <div>
          <span className="eyebrow">Holder</span>
          <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>Your credentials</h1>
        </div>
        <div className="row" style={{ gap: "0.75rem", alignItems: "center" }}>
          {portfolioAccounts.length > 0 && (
            <AccountPortfolioSwitcher
              accounts={portfolioAccounts}
              activeAddress={activeAccountFilter}
              onSelectAccount={handleSelectPortfolioAccount}
            />
          )}
          {/* Selective disclosure presets (#386): a named, shareable bundle
              of several claim types — defined and shared from its own page
              rather than crowding this one, but linked from here since the
              issue asks for the entry point to live on the holder page. */}
          <a href="/presets" className="btn btn-secondary">
            Presets
          </a>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowExportModal(true)}
            id="btn-open-export-modal"
          >
            <IconFileExport size={15} style={{ marginRight: "0.3rem" }} />
            Export Data
          </button>
          <WalletButton />
        </div>
      </div>

      <OnboardingNudge />

      <ConfigBanner />

      <WalletOnboarding />

      {/* Hardware-wallet credential management guide (#1040). */}
      {walletId === "ledger" && <LedgerGuide address={address} />}

      <SponsorBanner />

      {isPreview && <PreviewWalletBanner onConnect={connect} />}

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
        <div className="stack reveal" style={{ gap: "1.5rem" }} aria-busy={showSkeleton}>
          {showSkeleton ? (
            <CredListSkeleton rows={3} />
          ) : (
            <>
              {/* ── Expiry warning banner ── */}
              {(expiringSoon.length > 0 || expired.length > 0) && (
                <div
                  role="status"
                  aria-live="polite"
                  className="card"
                  style={{
                    padding: "0.85rem 1.15rem",
                    backgroundColor:
                      expired.length > 0 ? "rgba(239, 68, 68, 0.08)" : "rgba(234, 179, 8, 0.08)",
                    borderColor:
                      expired.length > 0 ? "rgba(239, 68, 68, 0.3)" : "rgba(234, 179, 8, 0.3)",
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
                      style={{
                        color: expired.length > 0 ? "var(--danger)" : "var(--warn)",
                        flexShrink: 0,
                      }}
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

              {/* ── Empty state ── */}
              {creds.length === 0 && !importing && <EmptyCredentialsState />}

              {/* ── Expiring soon (action recommended) ── */}
              {expiringSoon.length > 0 && (
                <div className="stack" style={{ gap: "0.6rem" }}>
                  <SectionLabel>Expiring soon · Re-prove recommended</SectionLabel>
                  {expiringSoon.map((c) => renderCred(c))}
                </div>
              )}

              {/* ── Expired (action required) ── */}
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
                  {expired.map((c) => renderCred(c))}
                </div>
              )}

              {/* ── Credentials to prove ── */}
              {unproved.length > 0 && (
                <div className="stack" style={{ gap: "0.6rem" }}>
                  <SectionLabel>Ready to prove</SectionLabel>
                  {unproved.map((c) =>
                    renderCred(
                      c,
                      canBatch
                        ? {
                            checked: selectedCommitments.includes(c.commitment),
                            blockedReason: blockedReason(c),
                            onToggle: () => toggleSelected(c),
                          }
                        : undefined,
                    ),
                  )}
                  {/* Select up to MAX_BATCH_SIZE credentials of distinct types
                      and prove them in one transaction. */}

                  {/* Select up to MAX_BATCH_SIZE credentials of distinct types and
                  prove them in one transaction. */}
                  {canBatch && (
                    <BatchBar
                      selectedCount={selectedCreds.length}
                      atBatchLimit={atBatchLimit}
                      canSubmitBatch={canSubmitBatch}
                      onProveBatch={() =>
                        proofApproval.request({ kind: "batch", creds: selectedCreds })
                      }
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

              {/* ── Active proved ── */}
              {activeProved.length > 0 && (
                <div className="stack" style={{ gap: "0.6rem" }}>
                  <SectionLabel>On-chain · active proofs</SectionLabel>
                  {activeProved.map((c) => renderCred(c))}
                </div>
              )}

              {!address && creds.length > 0 && (
                <p className="faint" style={{ fontSize: "0.8125rem" }}>
                  Connect a wallet to generate and submit proofs.
                </p>
              )}

              {/* ── Import / export ── */}
              {importing ? (
                <ImportPanel
                  onImport={(c) => {
                    save(c);
                    setImporting(false);
                  }}
                  onCancel={() => setImporting(false)}
                />
              ) : (
                <div className="stack" style={{ gap: "0.55rem" }}>
                  <div className="row" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setImporting(true)}>
                      <IconPlus size={14} />
                      Import credential JSON
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={downloadBackup}
                      disabled={creds.length === 0}
                      title={
                        creds.length === 0
                          ? "No credentials to back up yet"
                          : "Download a JSON backup of all credentials"
                      }
                    >
                      <IconDownload size={14} />
                      Export backup
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setShowExportModal(true)}
                      id="btn-export-data-action"
                      title="Request scoped exports with secure expiring download links"
                    >
                      <IconFileExport size={14} />
                      Export data
                    </button>
                    <GuardianRecoveryControl
                      hasCredentials={creds.length > 0}
                      onRestored={reload}
                    />
                  </div>
                  <p
                    className="faint"
                    style={{ fontSize: "0.75rem", maxWidth: 560, lineHeight: 1.6, margin: 0 }}
                  >
                    Credentials live only in this browser (localStorage) — export a backup before
                    clearing site data or switching devices, and restore it here with “Import
                    credential JSON”.{" "}
                    <Link
                      href="/docs#storage"
                      style={{ color: "var(--accent)", textDecoration: "underline" }}
                    >
                      Where your credentials live
                    </Link>
                  </p>
                  <ExportVisibilitySettings />
                </div>
              )}
            </>
          )}
        </div>
      )}

      <CredentialExportPanel />

      {detailCred && (
        <CredentialDetailModal
          // ClaimParams is an interface, so it isn't assignable to the modal's
          // Record<string, unknown> prop without a cast.
          credential={detailCred as any}
          onClose={() => setDetailCred(null)}
          onTransfer={(c) => {
            setDetailCred(null);
            setTransferCred(c as Credential);
          }}
        />
      )}

      {transferCred && (
        <TransferExportModal cred={transferCred} onClose={() => setTransferCred(null)} />
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

      <ExportDataModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        userAddress={address || undefined}
        isAdmin={false}
      />

      {proofApproval.creds && (
        <DisclosurePreviewModal
          creds={proofApproval.creds}
          holder={address}
          onApprove={proofApproval.approve}
          onCancel={proofApproval.cancel}
        />
      )}

      {confirmBulkAction && (
        <ConfirmRemoveModal
          count={confirmBulkAction.commitments.length}
          label={
            confirmBulkAction.type === "clear-expired"
              ? "Clear Expired Credentials?"
              : "Remove Selected Credentials?"
          }
          onConfirm={() => executeBulkRemove(confirmBulkAction.commitments)}
          onCancel={() => setConfirmBulkAction(null)}
        />
      )}
    </>
  );
}

// useSearchParams() must be inside a Suspense boundary in the App Router.
export default function HolderPageClient() {
  return (
    <Suspense fallback={null}>
      <HolderInner />
    </Suspense>
  );
}
