"use client";

/**
 * credential-export.ts — Portable credential export with review history.
 *
 * Issue #909: End users need a way to export their credential history and
 * trust metadata in a portable format. This module produces a structured
 * JSON document that includes:
 *
 *   - All credentials with their proof status and expiry information
 *   - A submission history (from lib/history.ts) showing every proof
 *     submission with transaction hash and outcome
 *   - A review summary: aggregate counts of credentials by type, status,
 *     and issuer — enough for a third party to assess the holder's
 *     credential portfolio without seeing the underlying private attributes
 *   - Local retention guidance metadata so the export consumer knows
 *     how long to keep the file and what it contains
 *
 * The export is deliberately **non-secret**: it contains commitment hashes,
 * issuer addresses, and proof status — never the raw attribute values or
 * the issuer's signature. It is safe to share with a protocol for review
 * purposes. For a full (encrypted) backup including private values, use
 * lib/backup.ts (createEncryptedBackup).
 *
 * ## Format
 *
 * ```json
 * {
 *   "format": "stellarcred-credential-export",
 *   "version": 1,
 *   "exportedAt": 1700000000,
 *   "deployment": { "network": "testnet", ... },
 *   "summary": {
 *     "totalCredentials": 5,
 *     "byType": { "kyc": 1, "age": 1, ... },
 *     "byStatus": { "proved": 3, "unproved": 1, "expired": 1 },
 *     "issuers": ["G...", "G..."],
 *     "oldestIssuedAt": 1690000000,
 *     "newestIssuedAt": 1700000000
 *   },
 *   "credentials": [
 *     {
 *       "type": "kyc",
 *       "title": "KYC Complete",
 *       "issuer": "StellarCred Authority",
 *       "issuerId": "G...",
 *       "commitment": "0x...",
 *       "issuedAt": 1690000000,
 *       "expiry": "90 days",
 *       "proofStatus": "proved",
 *       "provedAt": 1695000000,
 *       "provedTxHash": "abc...",
 *       "daysRemaining": 45
 *     }
 *   ],
 *   "submissionHistory": [
 *     {
 *       "credentialType": "kyc",
 *       "timestamp": 1695000000,
 *       "txHash": "abc...",
 *       "status": "confirmed"
 *     }
 *   ],
 *   "retentionPolicy": {
 *     "description": "This file contains public credential metadata only — no private attribute values.",
 *     "containsSecrets": false,
 *     "safeToShare": true,
 *     "recommendedRetention": "Delete after review or when no longer needed."
 *   }
 * }
 * ```
 */

import { loadCredentials, type Credential } from "./credential";
import { getSubmissions, type SubmissionRecord } from "./history";
import { currentDeploymentRef, type DeploymentRef } from "./deployment";
import { proofStatus, daysRemaining, credExpiryTimestamp } from "./proof-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public, non-secret view of a credential for the export document. */
export interface ExportedCredential {
  type: string;
  title: string;
  claim: string;
  issuer: string;
  issuerId: string;
  /** Poseidon2 commitment hash — not the raw attribute value. */
  commitment: string;
  issuedAt: number;
  expiry: string;
  proofStatus: "unproved" | "proved" | "expired";
  provedAt: number | null;
  provedTxHash: string | null;
  /** Days until the proof expires (0 if expired or unproved). */
  daysRemaining: number;
  /** Absolute expiry timestamp (unix seconds). */
  expiresAt: number;
}

/** Aggregate counts for the review summary. */
export interface CredentialSummary {
  totalCredentials: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  /** Distinct issuer addresses. */
  issuers: string[];
  /** Unix seconds of the earliest credential issuance, or null if empty. */
  oldestIssuedAt: number | null;
  /** Unix seconds of the latest credential issuance, or null if empty. */
  newestIssuedAt: number | null;
}

/** Local retention guidance for the consumer of the export. */
export interface RetentionPolicy {
  description: string;
  containsSecrets: boolean;
  safeToShare: boolean;
  recommendedRetention: string;
}

/** The full export document. */
export interface CredentialExport {
  format: "stellarcred-credential-export";
  version: 1;
  exportedAt: number;
  deployment: DeploymentRef;
  summary: CredentialSummary;
  credentials: ExportedCredential[];
  submissionHistory: SubmissionRecord[];
  retentionPolicy: RetentionPolicy;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Convert a full Credential (which includes private signature data and raw
 * attribute values) into the public, non-secret ExportedCredential shape.
 *
 * Strips: sig, issuerPubX, issuerPubY, value, salt, claimParams, seniority.
 * Keeps: type, title, claim (public description), issuer, issuerId,
 * commitment (hash), issuedAt, expiry, proof status, and proof timestamps.
 */
function toExportedCredential(cred: Credential): ExportedCredential {
  const status = proofStatus(cred);
  return {
    type: cred.type,
    title: cred.title,
    claim: cred.claim,
    issuer: cred.issuer,
    issuerId: cred.issuerId,
    commitment: cred.commitment,
    issuedAt: cred.issuedAt,
    expiry: cred.expiry,
    proofStatus: status,
    provedAt: cred.provedAt ?? null,
    provedTxHash: cred.provedTxHash ?? null,
    daysRemaining: status === "proved" ? daysRemaining(cred) : 0,
    expiresAt: credExpiryTimestamp(cred),
  };
}

/**
 * Build the aggregate summary from a list of exported credentials.
 */
function buildSummary(creds: ExportedCredential[]): CredentialSummary {
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const issuerSet = new Set<string>();
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const c of creds) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    byStatus[c.proofStatus] = (byStatus[c.proofStatus] ?? 0) + 1;
    issuerSet.add(c.issuerId);
    if (oldest === null || c.issuedAt < oldest) oldest = c.issuedAt;
    if (newest === null || c.issuedAt > newest) newest = c.issuedAt;
  }

  return {
    totalCredentials: creds.length,
    byType,
    byStatus,
    issuers: Array.from(issuerSet).sort(),
    oldestIssuedAt: oldest,
    newestIssuedAt: newest,
  };
}

const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  description:
    "This file contains public credential metadata only — commitment hashes, issuer addresses, and proof status. It does not contain private attribute values or issuer signatures.",
  containsSecrets: false,
  safeToShare: true,
  recommendedRetention:
    "Delete after review or when no longer needed. For a full encrypted backup including private data, use the encrypted backup feature in the holder page.",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a portable credential export document from the user's local credentials
 * and submission history.
 *
 * The document is safe to share — it contains only public metadata, never the
 * raw attribute values or issuer signatures. For a full encrypted backup, use
 * lib/backup.ts (createEncryptedBackup) instead.
 *
 * @returns The structured export document, or null if no credentials exist.
 */
export async function buildCredentialExport(): Promise<CredentialExport | null> {
  const credentials = await loadCredentials();
  if (credentials.length === 0) return null;

  const exportedCreds = credentials.map(toExportedCredential);
  const summary = buildSummary(exportedCreds);
  const submissionHistory = getSubmissions();

  return {
    format: "stellarcred-credential-export",
    version: 1,
    exportedAt: Math.floor(Date.now() / 1000),
    deployment: currentDeploymentRef(),
    summary,
    credentials: exportedCreds,
    submissionHistory,
    retentionPolicy: DEFAULT_RETENTION_POLICY,
  };
}

/**
 * Serialize the credential export as a pretty-printed JSON string and trigger
 * a browser download.
 *
 * @param filename  Override the default filename.
 * @returns The export document, or null if no credentials exist.
 */
export async function downloadCredentialExport(
  filename?: string,
): Promise<CredentialExport | null> {
  const exportDoc = await buildCredentialExport();
  if (!exportDoc) return null;

  const date = new Date().toISOString().slice(0, 10);
  const name = filename ?? `stellarcred-credential-history-${date}.json`;
  const blob = new Blob([JSON.stringify(exportDoc, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);

  return exportDoc;
}

/**
 * Returns true when the user has submission history records.
 * Used by the UI to decide whether to show the "export history" button.
 */
export function hasSubmissionHistory(): boolean {
  return getSubmissions().length > 0;
}
