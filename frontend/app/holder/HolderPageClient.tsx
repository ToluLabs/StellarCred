"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
 feat/typed-claim-read-outcomes
import { IconArrowRight, IconAlertTriangle, IconCertificate, IconDownload, IconFileExport, IconPlus } from "@tabler/icons-react";

l test/indexer-db-conformance
import { IconArrowRight, IconAlertTriangle, IconCertificate, IconDownload, IconFileExport, IconPlus } from "@tabler/icons-react";

 feat/issue-1002-db-backup-migration-guidance
import {
  IconArrowRight, IconAlertTriangle, IconCertificate, IconDownload, IconFileExport, IconPlus,
} from "@tabler/icons-react";
 main

 docs/proof-expiry-vs-storage-ttl
import { IconArrowRight, IconAlertTriangle, IconCertificate, IconDownload, IconFileExport, IconPlus } from "@tabler/icons-react";

import { IconAlertTriangle, IconDownload, IconFileExport, IconPlus } from "@tabler/icons-react";
 main
 main
 main

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
// ── Components ────────────────────────────────────────────────────────────────
import { CredCard } from "@/components/holder/CredCard";
import { CredListSkeleton } from "@/components/holder/CredListSkeleton";
import { useProofApproval } from "@/lib/hooks/useProofApproval";
 feat/sdk-event-stream
import { useTransferImportParam } from "@/lib/hooks/useTransferImportParam";

import { useCredentialBuckets } from "@/lib/hooks/useCredentialBuckets";
 main

import { CredCard, type BatchSelection } from "@/components/holder/CredCard";
import { SectionLabel } from "@/components/holder/SectionLabel";
import { ImportPanel } from "@/components/holder/ImportPanel";
import { BatchBar } from "@/components/holder/BatchBar";
import { ConfirmRemoveModal } from "@/components/holder/ConfirmRemoveModal";
import { SponsorBanner } from "@/components/holder/SponsorBanner";
import { GuardianRecoveryControl } from "@/components/holder/GuardianRecoveryControl";
import { ProofFlowView } from "@/components/holder/ProofFlowView";
import { BatchProofFlowView } from "@/components/holder/BatchProofFlowView";
import { CredentialExportPanel } from "@/components/holder/CredentialExportPanel";
 fix/issue-991-staged-deploy
import type { PageView, BulkAction } from "./types";

import { EmptyCredentialsState } from "@/components/holder/EmptyCredentialsState";
import { PreviewWalletBanner } from "@/components/holder/PreviewWalletBanner";
 main

// The encrypted-transfer modals are heavy (crypto.ts PBKDF2/AES-GCM, QR
// rendering) and only needed when the user actually starts a transfer â€” load
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

 fix/issue-991-staged-deploy
type PageView =
  { kind: "list" } | { kind: "single"; cred: Credential } | { kind: "batch"; creds: Credential[] };

type BulkAction = {
  type: "remove-selected" | "clear-expired";
  commitments: string[];
};
        main
function HolderInner() {
  const { address, connect, restoring } = useWallet();
  // While a saved wallet is restoring, `address` is briefly empty. Treating that
  // as preview mode flashes demo credentials and banners before swapping in the
  // real list, so hold loading UI until the restore settles.
  const isPreview = usePreviewMode() && !restoring;
  const { address, walletId, connect } = useWallet();
  const isPreview = usePreviewMode();
  const toast = useToast();

 main
  // ── Credential store ───────────────────────────────────────────────────────
  const { creds, loading, save, remove, markCredentialProved, markCredentialsProved } =
    useCredentialStore();
  // Show placeholders while credentials hydrate — never the "no credentials"
  // empty state, which would then be replaced by a populated list.
  const showSkeleton = loading && !isPreview;

  // ── Import/export ──────────────────────────────────────────────────────────
  const { creds, reload, save, remove, markCredentialProved, markCredentialsProved } = useCredentialStore();

  const { creds, reload, save, remove, markCredentialProved, markCredentialsProved } =
    useCredentialStore();
 main
  const { downloadBackup } = useImportExport();

  const [view, setView] = useState<PageView>({ kind: "list" });
  const proofApproval = useProofApproval(setView);
  const [importing, setImporting] = useState(false);
  const [detailCred, setDetailCred] = useState<Credential | null>(null);
  const [transferCred, setTransferCred] = useState<Credential | null>(null);
  const [importPayload, setImportPayload] = useState<string | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [confirmBulkAction, setConfirmBulkAction] = useState<BulkAction | null>(null);

 feat/sdk-event-stream
  useTransferImportParam(setImportPayload);

  // A transfer QR opened directly (native camera app -> /holder?import=...)
  // lands here with the payload already in the URL â€” prompt for the
  // passphrase immediately, and strip it from the URL so a refresh or the
  // back button doesn't re-trigger the prompt or leave ciphertext in history.
  useEffect(() => {
    const payload = searchParams.get(IMPORT_PARAM);
    if (!payload) return;
    setImportPayload(payload);
    router.replace("/holder");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
 main

  const displayCreds = isPreview ? PREVIEW_CREDENTIALS : creds;
  const { unproved, expiringSoon, activeProved, expired } = useCredentialBuckets(displayCreds);

  // Warm the UltraHonk backend for whatever credential types the user still
  // needs to prove, in the background, once the wallet is actually connected
  // (never in preview mode â€” there's nothing real to prove yet). Only the
  // types actually present in `unproved` are warmed, not all seven circuits,
  // to avoid paying wasm-init cost for types the user has no credential for.
  const unprovedTypes = Array.from(new Set(unproved.map((c) => c.type)));
  useWarmProver(unprovedTypes, Boolean(address));

  // Batch selection enforces both on-chain limits (size + one per type) before
  // anything is proved â€” see useBatchSelection.
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

  /** One credential card â€” shared by every section below. */
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
        <div className="row" style={{ gap: "0.75rem" }}>
          {/* Selective disclosure presets (#386): a named, shareable bundle
              of several claim types â€” defined and shared from its own page
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
                expired.length > 0 ? "rgba(239,68,68,0.08)" : "rgba(234,179,8,0.08)",
              borderColor:
                expired.length > 0 ? "rgba(239,68,68,0.3)" : "rgba(234,179,8,0.3)",
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
        {creds.length === 0 && !importing && (
          <div
            className="card"
            style={{ textAlign: "center", padding: "3.5rem 1.5rem", borderStyle: "dashed" }}
          >
            <IconCertificate size={30} stroke={1.3} color="var(--faint)" />
            <h3 style={{ margin: "1rem 0 0.4rem" }}>No credentials yet</h3>
            <p
              className="muted"
              style={{ fontSize: "0.875rem", maxWidth: 340, margin: "0 auto 1.5rem" }}
            >
              Get a credential from a trusted issuer, then generate a zero-knowledge
              proof to verify it on-chain.
            </p>
            <a
              href="/verify"
              className="btn btn-primary btn-sm"
              style={{ display: "inline-flex" }}
            >
              Get a credential
              <IconArrowRight size={14} />
            </a>
            <p
              className="faint"
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
          {/* -- Expiry warning banner -- */}
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

 fix/issue-991-staged-deploy
          {/* -- Empty state -- */}
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
                Credentials are stored only in this browser&apos;s local storage â€” clearing
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

          {creds.length === 0 && !importing && <EmptyCredentialsState />}
 main

          {/* -- Expiring soon (action recommended) -- */}
          {expiringSoon.length > 0 && (
            <div className="stack" style={{ gap: "0.6rem" }}>
              <SectionLabel>Expiring soon â€” Re-prove recommended</SectionLabel>
              {expiringSoon.map((c) => renderCred(c))}
            </div>
          )}

          {/* -- Expired (action required) -- */}
          {expired.length > 0 && (
            <div className="stack" style={{ gap: "0.6rem" }}>
              <SectionLabel>Expired proofs â€” Re-prove required</SectionLabel>
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

          {/* -- Credentials to prove -- */}
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
                    : undefined
                }
              />
            ))}
            {canBatch && (
              <BatchBar
                selectedCount={selectedCreds.length}
                atBatchLimit={atBatchLimit}
                canSubmitBatch={canSubmitBatch}
                onProveBatch={() =>
                  setView({ kind: "batch", creds: selectedCreds })
                }
                onClear={clearSelection}
                onSelectEligible={selectEligible}
                onRemoveSelected={
                  selectedCreds.length > 0
                    ? () =>
                        setConfirmRemove({
                          label: "Remove Selected Credentials?",
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
            <h3 style={{ margin: 0, fontSize: "0.9rem" }}>On-chain · active proofs</h3>
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

          </>
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
                    : undefined,
                ),
              )}

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

          {/* -- Active proved -- */}
          {activeProved.length > 0 && (
            <div className="stack" style={{ gap: "0.6rem" }}>
              <SectionLabel>On-chain â€” active proofs</SectionLabel>
              {activeProved.map((c) => renderCred(c))}
            </div>
          )}

          {!address && creds.length > 0 && (
            <p className="faint" style={{ fontSize: "0.8125rem" }}>
              Connect a wallet to generate and submit proofs.
            </p>
          )}

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
                <GuardianRecoveryControl hasCredentials={creds.length > 0} onRestored={reload} />
              </div>
 fix/issue-991-staged-deploy
              <p className="faint" style={{ fontSize: "0.75rem", maxWidth: 560, lineHeight: 1.6, margin: 0 }}>
                Credentials live only in this browser (localStorage) â€” export a backup
                before clearing site data or switching devices, and restore it here with{" "}
                &ldquo;Import credential JSON&rdquo;.{" "}

              <p
                className="faint"
                style={{ fontSize: "0.75rem", maxWidth: 560, lineHeight: 1.6, margin: 0 }}
              >
                Credentials live only in this browser (localStorage) — export a backup before
                clearing site data or switching devices, and restore it here with “Import credential
                JSON”.{" "}
 main
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
