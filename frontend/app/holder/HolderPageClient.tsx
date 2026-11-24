"use client";

import { Suspense, useState } from "react";

import { ConfigBanner } from "@/components/ConfigBanner";
import { LedgerGuide } from "@/components/LedgerGuide";
import { OnboardingNudge } from "@/components/OnboardingNudge";
import { useToast } from "@/components/Toast";
import { WalletOnboarding } from "@/components/WalletOnboarding";
import { CredCard, type BatchSelection } from "@/components/holder/CredCard";
import { CredListSkeleton } from "@/components/holder/CredListSkeleton";
import { CredentialExportPanel } from "@/components/holder/CredentialExportPanel";
import { EmptyCredentialsState } from "@/components/holder/EmptyCredentialsState";
import { ExpiryWarningBanner } from "@/components/holder/ExpiryWarningBanner";
import { HolderHeader } from "@/components/holder/HolderHeader";
import { HolderImportExport } from "@/components/holder/HolderImportExport";
import { HolderModals } from "@/components/holder/HolderModals";
import { PreviewWalletBanner } from "@/components/holder/PreviewWalletBanner";
import { ProofFlowView } from "@/components/holder/ProofFlowView";
import { BatchProofFlowView } from "@/components/holder/BatchProofFlowView";
import { SectionLabel } from "@/components/holder/SectionLabel";
import { SponsorBanner } from "@/components/holder/SponsorBanner";
import { BatchBar } from "@/components/holder/BatchBar";
import { removeCredential, type Credential } from "@/lib/credential";
import { useBatchSelection } from "@/lib/hooks/useBatchSelection";
import { useCredentialBuckets } from "@/lib/hooks/useCredentialBuckets";
import { useCredentialStore } from "@/lib/hooks/useCredentialStore";
import { useImportExport } from "@/lib/hooks/useImportExport";
import { useProofApproval } from "@/lib/hooks/useProofApproval";
import { useTransferImportParam } from "@/lib/hooks/useTransferImportParam";
import { PREVIEW_CREDENTIALS } from "@/lib/preview-fixtures";
import { useWarmProver } from "@/lib/use-warm-prover";
import { usePreviewMode, useWallet } from "@/lib/wallet-context";

import type { BulkAction, PageView } from "./types";

function HolderInner() {
  const { address, walletId, connect, restoring } = useWallet();
  // While a saved wallet is restoring, `address` is briefly empty. Treating that
  // as preview mode flashes demo credentials and banners before swapping in the
  // real list, so hold loading UI until the restore settles.
  const isPreview = usePreviewMode() && !restoring;
  const toast = useToast();

  // ── Credential store ───────────────────────────────────────────────────────
  const { creds, loading, save, remove, reload, markCredentialProved, markCredentialsProved } =
    useCredentialStore();
  // Show placeholders while credentials hydrate — never the "no credentials"
  // empty state, which would then be replaced by a populated list.
  const showSkeleton = loading && !isPreview;

  // ── Import/export ──────────────────────────────────────────────────────────
  const { downloadBackup } = useImportExport();

  const [view, setView] = useState<PageView>({ kind: "list" });
  const proofApproval = useProofApproval(setView);
  const [importing, setImporting] = useState(false);
  const [detailCred, setDetailCred] = useState<Credential | null>(null);
  const [transferCred, setTransferCred] = useState<Credential | null>(null);
  const [importPayload, setImportPayload] = useState<string | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [confirmBulkAction, setConfirmBulkAction] = useState<BulkAction | null>(null);

  // A transfer QR opened directly (native camera app -> /holder?import=...)
  // hands the payload here and strips it from the URL so the prompt is not
  // re-triggered on refresh or back navigation.
  useTransferImportParam(setImportPayload);

  const displayCreds = isPreview ? PREVIEW_CREDENTIALS : creds;
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

  const bulkConfirm = confirmBulkAction && {
    count: confirmBulkAction.commitments.length,
    label:
      confirmBulkAction.type === "clear-expired"
        ? "Clear Expired Credentials?"
        : "Remove Selected Credentials?",
    onConfirm: () => executeBulkRemove(confirmBulkAction.commitments),
  };

  return (
    <>
      <HolderHeader onExportData={() => setShowExportModal(true)} />

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
              {(expiringSoon.length > 0 || expired.length > 0) && (
                <ExpiryWarningBanner
                  expiringCount={expiringSoon.length}
                  expiredCount={expired.length}
                />
              )}

              {creds.length === 0 && !importing && <EmptyCredentialsState />}

              {/* ── Expiring soon (action recommended) ── */}
              {expiringSoon.length > 0 && (
                <div className="stack" style={{ gap: "0.6rem" }}>
                  <SectionLabel>Expiring soon — Re-prove recommended</SectionLabel>
                  {expiringSoon.map((c) => renderCred(c))}
                </div>
              )}

              {/* ── Expired (action required) ── */}
              {expired.length > 0 && (
                <div className="stack" style={{ gap: "0.6rem" }}>
                  <SectionLabel>Expired proofs — Re-prove required</SectionLabel>
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
                      onRemoveSelected={
                        selectedCreds.length > 0
                          ? () =>
                              setConfirmBulkAction({
                                type: "remove-selected",
                                commitments: selectedCommitments,
                              })
                          : undefined
                      }
                    />
                  )}
                </div>
              )}

              {/* ── Active on-chain proofs ── */}
              {activeProved.length > 0 && (
                <div className="stack" style={{ gap: "0.6rem" }}>
                  <SectionLabel>On-chain — active proofs</SectionLabel>
                  {activeProved.map((c) => renderCred(c))}
                </div>
              )}

              {!address && creds.length > 0 && (
                <p className="faint" style={{ fontSize: "0.8125rem" }}>
                  Connect a wallet to generate and submit proofs.
                </p>
              )}
            </>
          )}

          <HolderImportExport
            credsCount={creds.length}
            importing={importing}
            onStartImport={() => setImporting(true)}
            onCancelImport={() => setImporting(false)}
            onImported={(c) => {
              save(c);
              setImporting(false);
            }}
            downloadBackup={downloadBackup}
            onExportData={() => setShowExportModal(true)}
            onRestored={reload}
          />
        </div>
      )}

      <CredentialExportPanel />

      <HolderModals
        address={address}
        detailCred={detailCred}
        onCloseDetail={() => setDetailCred(null)}
        onStartTransfer={setTransferCred}
        transferCred={transferCred}
        onCloseTransfer={() => setTransferCred(null)}
        importPayload={importPayload}
        onImported={(c) => {
          save(c);
          setImportPayload(null);
          toast.success(`Imported ${c.title}`);
        }}
        onCloseImport={() => setImportPayload(null)}
        showExportModal={showExportModal}
        onCloseExport={() => setShowExportModal(false)}
        proofCreds={proofApproval.creds}
        onApproveProof={proofApproval.approve}
        onCancelProof={proofApproval.cancel}
        bulkConfirm={bulkConfirm || null}
        onCancelBulk={() => setConfirmBulkAction(null)}
      />
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
