/**
 * Export record store for admin tooling (#783).
 *
 * Tracks export artifacts and their revocation state. Uses an in-memory Map
 * as the authoritative source with a shared-store KV fallback for persistence.
 */

import { getSharedStore } from "./shared-store";

export interface ExportRecord {
  id: string;
  issuer: string;
  commitment: string;
  credentialType: string;
  requestedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  artifactUrl: string | null;
  metadata: Record<string, string>;
}

// In-memory store — authoritative source for tests and server-side calls
const memoryRecords = new Map<string, ExportRecord>();

/**
 * Create a new export record. Generates an ID, sets revokedAt/revokedBy to null.
 */
export async function createExportRecord(
  input: Omit<ExportRecord, "id" | "revokedAt" | "revokedBy">,
): Promise<ExportRecord> {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const record: ExportRecord = {
    ...input,
    id,
    revokedAt: null,
    revokedBy: null,
  };

  memoryRecords.set(id, record);

  const sharedStore = getSharedStore();
  await sharedStore.set(`export:record:${id}`, JSON.stringify(record)).catch(() => null);

  return record;
}

/**
 * List export records sorted by requestedAt descending, up to `limit` records.
 *
 * ARCHITECTURAL NOTE: This function reads only the in-memory Map. The
 * KeyValueStore interface used for the shared-store fallback does not provide
 * a key-enumeration method, so exports created in a prior serverless invocation
 * or a different process instance are not visible here even though
 * getExportRecord() would find them individually via the shared store.
 *
 * In a single-process deployment (local dev, Docker) this is not a concern.
 * In a multi-instance / serverless deployment, operators should be aware that
 * the admin list view may be incomplete. Individual records remain retrievable
 * by ID. A future iteration that adds key enumeration to KeyValueStore (or
 * uses a dedicated DB table) would close this gap.
 */
export async function listExportRecords(limit = 100): Promise<ExportRecord[]> {
  const all = Array.from(memoryRecords.values());
  all.sort((a, b) => {
    if (a.requestedAt > b.requestedAt) return -1;
    if (a.requestedAt < b.requestedAt) return 1;
    return 0;
  });
  return all.slice(0, limit);
}

/**
 * Get a single export record by ID. Checks memory first, then shared store.
 */
export async function getExportRecord(id: string): Promise<ExportRecord | null> {
  const mem = memoryRecords.get(id);
  if (mem) return mem;

  const sharedStore = getSharedStore();
  const raw = await sharedStore.get(`export:record:${id}`).catch(() => null);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ExportRecord;
      memoryRecords.set(id, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Revoke an export record. Returns null if the record is not found.
 */
export async function revokeExportRecord(
  id: string,
  revokedBy: string,
): Promise<ExportRecord | null> {
  const record = await getExportRecord(id);
  if (!record) return null;

  record.revokedAt = new Date().toISOString();
  record.revokedBy = revokedBy;

  memoryRecords.set(id, record);

  const sharedStore = getSharedStore();
  await sharedStore.set(`export:record:${id}`, JSON.stringify(record)).catch(() => null);

  return record;
}

/**
 * Clear the in-memory store for testing purposes.
 */
export function __resetExportStoreForTesting(): void {
  memoryRecords.clear();
}
