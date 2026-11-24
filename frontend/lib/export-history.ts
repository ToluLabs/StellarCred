"use client";

import type { Credential } from "./credential";
import { getSubmissions } from "./history";
import type { TimelineEvent } from "./useProofTimeline";

export interface ProofHistoryEntry {
  claimType: string;
  verifiedAt: number;
  expiry: number;
  txHash: string;
  issuer: string;
}

export interface ExportData {
  exportedAt: string;
  entries: ProofHistoryEntry[];
}

function getTimelineEventsForCredential(cred: Credential): TimelineEvent[] {
  try {
    const stored = localStorage.getItem(`proofTimeline:${cred.commitment}`);
    if (stored) {
      return (JSON.parse(stored) as { events: TimelineEvent[] }).events;
    }
  } catch {
    // ignore
  }
  return [];
}

function buildHistoryEntries(credentials: Credential[]): ProofHistoryEntry[] {
  const entries: ProofHistoryEntry[] = [];

  for (const cred of credentials) {
    const events = getTimelineEventsForCredential(cred);
    const verifiedEvent = events.find((e) => e.stage === "verified");

    if (verifiedEvent) {
      const match = cred.expiry?.match(/(\d+)/);
      const ttlSecs = (match ? parseInt(match[1]) : 30) * 86_400;
      const expiry = verifiedEvent.timestamp + ttlSecs;

      entries.push({
        claimType: cred.type,
        verifiedAt: verifiedEvent.timestamp,
        expiry,
        txHash: verifiedEvent.txHash || "",
        issuer: cred.issuerId,
      });
    }
  }

  const submissions = getSubmissions();
  for (const sub of submissions) {
    const alreadyExported = entries.some(
      (e) => e.txHash === sub.txHash && e.claimType === sub.credentialType
    );
    if (!alreadyExported) {
      entries.push({
        claimType: sub.credentialType,
        verifiedAt: sub.timestamp,
        expiry: 0,
        txHash: sub.txHash,
        issuer: "",
      });
    }
  }

  entries.sort((a, b) => a.verifiedAt - b.verifiedAt);
  return entries;
}

function formatTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toISOString();
}

function escapeCsvField(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function exportHistoryAsJson(credentials: Credential[]): string {
  const entries = buildHistoryEntries(credentials);
  const data: ExportData = {
    exportedAt: new Date().toISOString(),
    entries,
  };
  return JSON.stringify(data, null, 2);
}

export function exportHistoryAsCsv(credentials: Credential[]): string {
  const entries = buildHistoryEntries(credentials);
  const headers = [
    "claim_type",
    "verified_at",
    "expiry",
    "tx_hash",
    "issuer",
  ];

  const rows = entries.map((entry) =>
    [
      escapeCsvField(entry.claimType),
      formatTimestamp(entry.verifiedAt),
      entry.expiry ? formatTimestamp(entry.expiry) : "",
      escapeCsvField(entry.txHash),
      escapeCsvField(entry.issuer),
    ].join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}

export function downloadFile(
  content: string,
  filename: string,
  mimeType: string
): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadHistoryJson(credentials: Credential[]): void {
  const json = exportHistoryAsJson(credentials);
  const date = new Date().toISOString().slice(0, 10);
  downloadFile(json, `stellarcred-history-${date}.json`, "application/json");
}

export function downloadHistoryCsv(credentials: Credential[]): void {
  const csv = exportHistoryAsCsv(credentials);
  const date = new Date().toISOString().slice(0, 10);
  downloadFile(csv, `stellarcred-history-${date}.csv`, "text/csv");
}
