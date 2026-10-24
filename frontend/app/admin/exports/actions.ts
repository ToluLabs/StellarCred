"use server";

/**
 * Server Actions for the admin exports UI (#783).
 *
 * These run on the server, so they can call the export-store and audit-log
 * libraries directly — the ADMIN_API_KEY is only required by external HTTP
 * callers of /api/admin/*, not by the web UI (which is server-rendered).
 */

import { revalidatePath } from "next/cache";
import { revokeExportRecord, type ExportRecord } from "@/lib/export-store";
import {
  auditLogAppend,
  auditLogBootstrap,
  auditLogEntries,
  auditLogPersist,
  auditLogVerify,
  type AuditLogEntry,
} from "@/lib/audit-log";

export type RevokeResult =
  | {
      success: true;
      record: ExportRecord;
      auditEntries: AuditLogEntry[];
      chainValid: boolean;
    }
  | { success: false; error: string };

/**
 * Revoke an export artifact, append a tamper-evident audit event, persist the
 * chain, and return the refreshed audit log so the UI updates in one round
 * trip. Revalidates the page path so any other open admin view also refreshes.
 */
export async function revokeExportAction(
  id: string,
  revokedBy: string,
): Promise<RevokeResult> {
  if (!revokedBy || !revokedBy.trim()) {
    return { success: false, error: "revokedBy is required" };
  }

  await auditLogBootstrap();

  const record = await revokeExportRecord(id, revokedBy.trim());
  if (!record) {
    return { success: false, error: "export not found" };
  }

  auditLogAppend({
    timestamp: Date.now(),
    requestId: crypto.randomUUID(),
    issuer: revokedBy.trim(),
    commitment: id,
    adminAction: "revoke",
  });
  await auditLogPersist();
  revalidatePath("/admin/exports");

  const auditEntries = auditLogEntries();
  const { valid: chainValid } = auditLogVerify();

  return { success: true, record, auditEntries, chainValid };
}
