/**
 * Admin Exports page (#783) — Server Component.
 *
 * Fetches export records and the audit chain on the server by calling the
 * store/audit libraries directly (no HTTP round-trip, no ADMIN_API_KEY
 * needed). The interactive layer — revoke button and audit-log toggle — lives
 * in the AdminExportsClient client component, which calls the revokeExport
 * server action for mutations.
 */

import {
  auditLogBootstrap,
  auditLogEntries,
  auditLogVerify,
} from "@/lib/audit-log";
import { listExportRecords } from "@/lib/export-store";
import { AdminExportsClient } from "./AdminExportsClient";

export const dynamic = "force-dynamic";

export default async function AdminExportsPage() {
  await auditLogBootstrap();

  const exports = await listExportRecords();
  const auditEntries = auditLogEntries();
  const { valid: chainValid } = auditLogVerify();

  return (
    <AdminExportsClient
      initialExports={exports}
      initialAuditEntries={auditEntries}
      initialChainValid={chainValid}
    />
  );
}
