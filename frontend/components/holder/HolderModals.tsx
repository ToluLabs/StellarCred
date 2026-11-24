"use client";

import dynamic from "next/dynamic";

import CredentialDetailModal from "@/components/CredentialDetailModal";
import { ConfirmRemoveModal } from "@/components/holder/ConfirmRemoveModal";
import type { Credential } from "@/lib/credential";

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

type HolderModalsProps = {
  address: string;
  detailCred: Credential | null;
  onCloseDetail: () => void;
  onStartTransfer: (c: Credential) => void;
  transferCred: Credential | null;
  onCloseTransfer: () => void;
  importPayload: string | null;
  onImported: (c: Credential) => void;
  onCloseImport: () => void;
  showExportModal: boolean;
  onCloseExport: () => void;
  proofCreds: Credential[] | null;
  onApproveProof: () => void;
  onCancelProof: () => void;
  bulkConfirm: { count: number; label: string; onConfirm: () => void } | null;
  onCancelBulk: () => void;
};

/**
 * All holder-page overlays. Extracted from HolderPageClient (#441) so the page
 * shell stays under its size cap and the heavy modals stay out of the shell.
 */
export function HolderModals({
  address,
  detailCred,
  onCloseDetail,
  onStartTransfer,
  transferCred,
  onCloseTransfer,
  importPayload,
  onImported,
  onCloseImport,
  showExportModal,
  onCloseExport,
  proofCreds,
  onApproveProof,
  onCancelProof,
  bulkConfirm,
  onCancelBulk,
}: HolderModalsProps) {
  return (
    <>
      {detailCred && (
        <CredentialDetailModal
          // ClaimParams is an interface, so it isn't assignable to the modal's
          // Record<string, unknown> prop without a cast.
          credential={detailCred as any}
          onClose={onCloseDetail}
          onTransfer={(c) => {
            onCloseDetail();
            onStartTransfer(c as Credential);
          }}
        />
      )}

      {transferCred && <TransferExportModal cred={transferCred} onClose={onCloseTransfer} />}

      {importPayload && (
        <TransferImportModal
          payload={importPayload}
          onImported={onImported}
          onClose={onCloseImport}
        />
      )}

      <ExportDataModal
        isOpen={showExportModal}
        onClose={onCloseExport}
        userAddress={address || undefined}
        isAdmin={false}
      />

      {proofCreds && (
        <DisclosurePreviewModal
          creds={proofCreds}
          holder={address}
          onApprove={onApproveProof}
          onCancel={onCancelProof}
        />
      )}

      {bulkConfirm && (
        <ConfirmRemoveModal
          count={bulkConfirm.count}
          label={bulkConfirm.label}
          onConfirm={bulkConfirm.onConfirm}
          onCancel={onCancelBulk}
        />
      )}
    </>
  );
}
