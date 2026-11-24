"use client";

import { IconFileExport } from "@tabler/icons-react";
import { WalletButton } from "@/components/WalletButton";

/**
 * Page title and the global holder actions. Extracted from HolderPageClient
 * (#441) so the page shell stays under its size cap.
 */
export function HolderHeader({ onExportData }: { onExportData: () => void }) {
  return (
    <div className="between" style={{ marginBottom: "2.5rem" }}>
      <div>
        <span className="eyebrow">Holder</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>Your credentials</h1>
      </div>
      <div className="row" style={{ gap: "0.75rem" }}>
        {/* Selective disclosure presets (#386): a named, shareable bundle of
            several claim types — defined and shared from its own page rather
            than crowding this one, but linked from here since the issue asks
            for the entry point to live on the holder page. */}
        <a href="/presets" className="btn btn-secondary">
          Presets
        </a>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onExportData}
          id="btn-open-export-modal"
        >
          <IconFileExport size={15} style={{ marginRight: "0.3rem" }} />
          Export Data
        </button>
        <WalletButton />
      </div>
    </div>
  );
}
