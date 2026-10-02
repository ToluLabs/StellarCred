"use client";

/**
 * HolderPageClient — page shell for /holder.
 *
 * This file is intentionally thin: it owns only top-level page state (which
 * view is active, which modals are open) and delegates everything else to the
 * established lib/hooks and components/holder structure.
 *
 * DO NOT add feature logic inline here. The pattern is:
 *   - State / async logic → frontend/lib/hooks/
 *   - UI primitives         → frontend/components/holder/
 *   See CONTRIBUTING.md §"Holder page architecture" for the full rule.
 *
 * CI enforces a line-count ceiling on this file (scripts/check-holder-size.sh).
 * Adding inline logic will fail that check.
 */

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  IconPlus,
  IconAlertTriangle,
  IconCertificate,
  IconArrowRight,
  IconDownload,
  IconFileDownload,
  IconFileSpreadsheet,
} from "@tabler/icons-react";

import { WalletButton } from "@/components/WalletButton";
import { useWallet, usePreviewMode } from "@/lib/wallet-context";
import { ConfigBanner } from "@/components/ConfigBanner";
import { NetworkMismatchBanner } from "@/components/NetworkMismatchBanner";
import { proofSubmissionConfigured } from "@/lib/config";
import { truncateHash } from "@/lib/format";
import { EXPLORER_TX } from "@/lib/stellar";
import { computeWitness, proveWithBackend } from "@/lib/proof";
import { useWarmProver } from "@/lib/use-warm-prover";
import {
  submitProof,
  submitProofs,
  MAX_BATCH_SIZE,
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
  exportCredentials,
} from "@/lib/credential";
import { isStorageAvailable } from "@/lib/safe-storage";
import { downloadHistoryJson, downloadHistoryCsv } from "@/lib/export-history";
import { PREVIEW_CREDENTIALS } from "@/lib/preview-fixtures";
import { usePreviewMode } from "@/lib/wallet-context";
import CopyButton from "@/components/CopyButton";
import dynamic from "next/dynamic";
import CredentialDetailModal from "@/components/CredentialDetailModal";
import { IMPORT_PARAM } from "@/lib/transfer";
import { PREVIEW_CREDENTIALS } from "@/lib/preview-fixtures";
import { useWarmProver } from "@/lib/use-warm-prover";
import type { Credential } from "@/lib/credential";
import { DataWipePanel } from "@/components/DataWipePanel";
// ── Hooks ─────────────────────────────────────────────────────────────────────
import { useCredentialStore } from "@/lib/hooks/useCredentialStore";
import { useBatchSelection } from "@/lib/hooks/useBatchSelection";
import { useImportExport } from "@/lib/hooks/useImportExport";
// ── Components ────────────────────────────────────────────────────────────────
import { CredCard } from "@/components/holder/CredCard";
import { ImportPanel } from "@/components/holder/ImportPanel";
import { BatchBar } from "@/components/holder/BatchBar";
import { ProofFlowView } from "@/components/holder/ProofFlowView";
import { BatchProofFlowView } from "@/components/holder/BatchProofFlowView";
import { ConfirmRemoveModal } from "@/components/holder/ConfirmRemoveModal";
import { proofStatus, isExpiringSoon, daysRemaining } from "@/lib/proof-helpers";
// Heavy modals loaded lazily — keep the route's initial bundle small.
const TransferExportModal = dynamic(
  () => import("@/components/TransferExportModal").then((m) => m.TransferExportModal),
  { ssr: false },
);
const TransferImportModal = dynamic(
  () => import("@/components/TransferImportModal").then((m) => m.TransferImportModal),
  { ssr: false },
);

// ── Page view discriminant ────────────────────────────────────────────────────

type PageView =
  | { kind: "list" }
  | { kind: "single"; cred: Credential }
  | { kind: "batch"; creds: Credential[] };

// ── Main inner component ──────────────────────────────────────────────────────

function HolderInner() {
  const { address, connect } = useWallet();
  const isPreview = usePreviewMode();
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();

  // ── Credential store ───────────────────────────────────────────────────────
  const { creds, save, remove, markCredentialProved, markCredentialsProved } =
    useCredentialStore();

  // ── Import/export ──────────────────────────────────────────────────────────
  const { downloadBackup } = useImportExport();

  // ── View / modal state ─────────────────────────────────────────────────────
  const [view, setView] = useState<PageView>({ kind: "list" });
  const [importing, setImporting] = useState(false);
  const [detailCred, setDetailCred] = useState<Credential | null>(null);
  const [transferCred, setTransferCred] = useState<Credential | null>(null);
  const [importPayload, setImportPayload] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{
    label: string;
    commitments: string[];
  } | null>(null);

  // Deep-link: /holder?import=<payload> opens the transfer-import modal and
  // strips the param from the URL so a back/refresh doesn't re-trigger it.
  useEffect(() => {
    const rawImport = searchParams.get(IMPORT_PARAM);
    if (!rawImport || importPayload === rawImport) return;
    setImportPayload(rawImport);
    router.replace("/holder");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, importPayload, router]);

  // ── Derived credential lists ───────────────────────────────────────────────
  const displayCreds = isPreview ? PREVIEW_CREDENTIALS : creds;
  const unproved = displayCreds.filter((c) => proofStatus(c) === "unproved");
  const expiringSoon = displayCreds
    .filter((c) => proofStatus(c) === "proved" && isExpiringSoon(c, 7))
    .sort((a, b) => daysRemaining(a) - daysRemaining(b));
  const activeProved = displayCreds.filter(
    (c) => proofStatus(c) === "proved" && !isExpiringSoon(c, 7),
  );
  const expired = displayCreds.filter((c) => proofStatus(c) === "expired");

  // Warm the prover for credential types the user still needs to prove.
  const unprovedTypes = Array.from(new Set(unproved.map((c) => c.type)));
  useWarmProver(unprovedTypes, Boolean(address) && !isPreview);

  // ── Batch selection ────────────────────────────────────────────────────────
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

  // ── Bulk remove helpers ────────────────────────────────────────────────────
  async function executeBulkRemove(commitments: string[]) {
    for (const c of commitments) await remove(c);
    clearSelection();
    setConfirmRemove(null);
  }

  // ── Routing helpers ────────────────────────────────────────────────────────
  const goToList = () => setView({ kind: "list" });

  // ── Render: single-proof flow ──────────────────────────────────────────────
  if (view.kind === "single") {
    return (
      <ProofFlowView
        cred={view.cred}
        holder={address}
        onBack={goToList}
        onProved={(txHash) => {
          markCredentialProved(view.cred.commitment, txHash);
          goToList();
        }}
      />
    );
  }

  // ── Render: batch-proof flow ───────────────────────────────────────────────
  if (view.kind === "batch") {
    return (
      <BatchProofFlowView
        creds={view.creds}
        holder={address}
        onBack={goToList}
        onProved={(txHash, commitments) => {
          markCredentialsProved(commitments, txHash);
          goToList();
        }}
      />
    );
  }

  // ── Render: list view ──────────────────────────────────────────────────────
  return (
    <>
      {/* ── Page header ── */}
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

      <div className="stack reveal" style={{ gap: "1.5rem" }}>
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
              style={{
                fontSize: "0.75rem",
                maxWidth: 380,
                margin: "1.25rem auto 0",
                lineHeight: 1.6,
              }}
            >
              Credentials are stored only in this browser&apos;s local storage.{" "}
              <Link
                href="/docs#storage"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                Where your credentials live
              </Link>
            </p>
          </div>
        )}

        {/* ── Data Management ── */}
        {!importing && <div style={{ marginTop: "2.5rem", paddingTop: "2rem", borderTop: "1px solid var(--border)" }}><DataWipePanel /></div>}

        {/* ── Expiring soon ── */}
        {expiringSoon.length > 0 && (
          <div className="stack" style={{ gap: "0.6rem" }}>
            <h3 style={{ margin: 0, fontSize: "0.9rem", color: "var(--warn)" }}>
              Expiring soon · Re-prove recommended
            </h3>
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

        {/* ── Expired ── */}
        {expired.length > 0 && (
          <div className="stack" style={{ gap: "0.6rem" }}>
            <div className="between">
              <h3 style={{ margin: 0, fontSize: "0.9rem", color: "var(--danger)" }}>
                Expired proofs · Re-prove required
              </h3>
              <button
                className="btn btn-sm btn-ghost"
                style={{ color: "#ef4444", borderColor: "rgba(239,68,68,0.3)" }}
                onClick={() =>
                  setConfirmRemove({
                    label: "Clear Expired Credentials?",
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

        {/* ── Ready to prove ── */}
        {unproved.length > 0 && (
          <div className="stack" style={{ gap: "0.6rem" }}>
            <h3 style={{ margin: 0, fontSize: "0.9rem" }}>Ready to prove</h3>
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

          {!loading && (importing ? (
            <ImportPanel
              onImport={async (c) => {
                setCreds(await saveCredential(c));
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
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => downloadHistoryJson(creds)}
                  disabled={creds.length === 0}
                  title="Download proof history as JSON (non-sensitive fields only)"
                >
                  <IconFileDownload size={14} />
                  Export history JSON
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => downloadHistoryCsv(creds)}
                  disabled={creds.length === 0}
                  title="Download proof history as CSV (non-sensitive fields only)"
                >
                  <IconFileSpreadsheet size={14} />
                  Export history CSV
                </button>
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
            <p
              className="faint"
              style={{ fontSize: "0.75rem", maxWidth: 560, lineHeight: 1.6, margin: 0 }}
            >
              Credentials live only in this browser (localStorage) — export a backup before
              clearing site data or switching devices.{" "}
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

      {/* ── Modals ── */}
      {detailCred && (
        <CredentialDetailModal
          credential={detailCred as never}
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
      {confirmRemove && (
        <ConfirmRemoveModal
          count={confirmRemove.commitments.length}
          label={confirmRemove.label}
          onConfirm={() => executeBulkRemove(confirmRemove.commitments)}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </>
  );
}

// useSearchParams() requires a Suspense boundary in the App Router.
export default function HolderPageClient() {
  return (
    <Suspense fallback={null}>
      <HolderInner />
    </Suspense>
  );
}