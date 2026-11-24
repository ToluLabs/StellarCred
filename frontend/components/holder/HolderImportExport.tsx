"use client";

import Link from "next/link";
import { IconDownload, IconFileExport, IconPlus } from "@tabler/icons-react";

import { ExportVisibilitySettings } from "@/components/ExportVisibilitySettings";
import { GuardianRecoveryControl } from "@/components/holder/GuardianRecoveryControl";
import { ImportPanel } from "@/components/holder/ImportPanel";
import type { Credential } from "@/lib/credential";

type HolderImportExportProps = {
  credsCount: number;
  importing: boolean;
  onStartImport: () => void;
  onCancelImport: () => void;
  onImported: (c: Credential) => void;
  downloadBackup: () => void;
  onExportData: () => void;
  onRestored: (credentials: Credential[]) => void;
};

/**
 * Import, backup and scoped-export controls, plus the storage warning.
 * Extracted from HolderPageClient (#441) so the page shell stays under its
 * size cap.
 */
export function HolderImportExport({
  credsCount,
  importing,
  onStartImport,
  onCancelImport,
  onImported,
  downloadBackup,
  onExportData,
  onRestored,
}: HolderImportExportProps) {
  if (importing) {
    return <ImportPanel onImport={onImported} onCancel={onCancelImport} />;
  }

  return (
    <div className="stack" style={{ gap: "0.55rem" }}>
      <div className="row" style={{ gap: "0.6rem", flexWrap: "wrap" }}>
        <button className="btn btn-ghost btn-sm" onClick={onStartImport}>
          <IconPlus size={14} />
          Import credential JSON
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={downloadBackup}
          disabled={credsCount === 0}
          title={
            credsCount === 0
              ? "No credentials to back up yet"
              : "Download a JSON backup of all credentials"
          }
        >
          <IconDownload size={14} />
          Export backup
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={onExportData}
          id="btn-export-data-action"
          title="Request scoped exports with secure expiring download links"
        >
          <IconFileExport size={14} />
          Export data
        </button>
        <GuardianRecoveryControl hasCredentials={credsCount > 0} onRestored={onRestored} />
      </div>
      <p
        className="faint"
        style={{ fontSize: "0.75rem", maxWidth: 560, lineHeight: 1.6, margin: 0 }}
      >
        Credentials live only in this browser (localStorage) — export a backup before clearing site
        data or switching devices, and restore it here with &ldquo;Import credential JSON&rdquo;.{" "}
        <Link href="/docs#storage" style={{ color: "var(--accent)", textDecoration: "underline" }}>
          Where your credentials live
        </Link>
      </p>
      <ExportVisibilitySettings />
    </div>
  );
}
