"use client";

/**
 * useImportExport — import credential JSON and export backup files.
 *
 * Encapsulates the download-backup logic and credential parsing so the
 * holder page stays focused on orchestration.
 */

import { useCallback } from "react";
import { exportCredentials, parseCredential, type Credential } from "../credential";

export function useImportExport() {
  /** Downloads every locally stored credential as a JSON backup file. */
  const downloadBackup = useCallback(async () => {
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
  }, []);

  /** Parse a JSON string into a Credential, throwing on invalid input. */
  const parseImport = useCallback((json: string): Credential => {
    return parseCredential(json);
  }, []);

  return {
    downloadBackup,
    parseImport,
  };
}
