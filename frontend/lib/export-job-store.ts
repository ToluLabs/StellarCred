/**
 * Chunked export job store (#784).
 *
 * An export (`ExportRecord` from #783) is unchanged. This module introduces a
 * sibling `ExportJob` representing one chunked, resumable delivery session over
 * a record's exportable rows. At job creation the full ordered row set is
 * materialized and each chunk is persisted to the shared store under its own
 * key, so a chunk read after a worker restart is a single shared-store `get`,
 * not a recompute from lost in-memory state.
 *
 * All job state lives in the shared store (`getSharedStore()` — a separate
 * singleton from `export-store`'s in-memory `Map`). Module-level caches here
 * mirror the export-store pattern (memory first, shared-store fallback) and are
 * cleared by `__resetExportJobStoreForTesting()` — which never clears the
 * shared store, so `export:job:*`, chunks, `export:cursor:*`, and
 * `export:job:byrecord:*` survive a simulated restart.
 */

import { getSharedStore } from "./shared-store";
import type { ExportRecord } from "./export-store";

export const DEFAULT_CHUNK_SIZE = 100;
export const MAX_CHUNK_SIZE = 1000;

/** One unit of exported data. All fields are PII-free (commitment is a hash;
 *  issuer/ids are identifiers; values are metadata strings). */
export interface ExportRow {
  id: string;
  field: string;
  value: string;
}

export type ExportJobStatus = "active" | "completed";

/** A chunked delivery session for one ExportRecord. Persisted (minus chunk
 *  data) under `export:job:${jobId}`. */
export interface ExportJob {
  jobId: string;
  recordId: string; // parent ExportRecord id (binds cursor to path id)
  totalChunks: number;
  chunkSize: number; // rows per chunk (max rows in any chunk)
  totalRows: number;
  status: ExportJobStatus;
  createdAt: string; // ISO 8601
}

/** One materialized, persisted slice. Stored under
 *  `export:job:${jobId}:chunk:${index}`. */
export interface ExportChunk {
  index: number; // 0-based
  totalChunks: number;
  rows: ExportRow[]; // length <= chunkSize
}

/** Server-side progress/status record. Stored under `export:cursor:${jobId}`.
 *  This is the "persisted cursor that survives restarts". `status` tracks job
 *  progress only (active/completed); revocation is NOT modeled here (it lives
 *  on `ExportRecord.revokedAt`). */
export interface CursorHandle {
  jobId: string;
  recordId: string;
  lastIndex: number; // last chunk index served (-1 before first chunk)
  status: ExportJobStatus;
  updatedAt: string; // ISO 8601
  completedAt: string | null;
}

const jobCache = new Map<string, ExportJob>();
const chunkCache = new Map<string, ExportChunk>(); // key: `${jobId}:${index}`
const cursorHandleCache = new Map<string, CursorHandle>();

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * PII-free row projection from an ExportRecord. Emits exactly the rows below,
 * in this fixed order, with `id = record.id`:
 *   1. issuer, 2. commitment, 3. credentialType, 4. requestedAt,
 *   5. revokedAt, 6. revokedBy, 7. artifactUrl, then one `metadata.<key>` row
 *   per `Object.keys(record.metadata)` in insertion order.
 * Null optional fields emit `value: ""` (not skipped), so a revoked record
 * still surfaces its revocation info and the row count is stable per shape.
 */
export function buildExportRows(record: ExportRecord): ExportRow[] {
  const rows: ExportRow[] = [
    { id: record.id, field: "issuer", value: record.issuer },
    { id: record.id, field: "commitment", value: record.commitment },
    { id: record.id, field: "credentialType", value: record.credentialType },
    { id: record.id, field: "requestedAt", value: record.requestedAt },
    { id: record.id, field: "revokedAt", value: record.revokedAt ?? "" },
    { id: record.id, field: "revokedBy", value: record.revokedBy ?? "" },
    { id: record.id, field: "artifactUrl", value: record.artifactUrl ?? "" },
  ];
  for (const key of Object.keys(record.metadata)) {
    rows.push({
      id: record.id,
      field: `metadata.${key}`,
      value: record.metadata[key],
    });
  }
  return rows;
}

/**
 * Materialize + persist a job and all its chunks. All-or-nothing from the
 * caller's view: any shared-store write that throws propagates (no partial job
 * is returned or cached). Chunks are immutable after this.
 */
export async function createExportJob(input: {
  recordId: string;
  rows: ExportRow[];
  chunkSize?: number;
}): Promise<ExportJob> {
  const recordId = input.recordId;
  const chunkSize = Math.max(
    1,
    Math.min(input.chunkSize ?? DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE),
  );
  const totalRows = input.rows.length;
  const totalChunks = Math.max(1, Math.ceil(totalRows / chunkSize));
  const jobId = newId();
  const createdAt = new Date().toISOString();

  const job: ExportJob = {
    jobId,
    recordId,
    totalChunks,
    chunkSize,
    totalRows,
    status: "active",
    createdAt,
  };

  const store = getSharedStore();

  // Persist job metadata.
  await store.set(`export:job:${jobId}`, JSON.stringify(job));

  // Persist each chunk (pre-materialized so a post-restart read is one `get`).
  for (let i = 0; i < totalChunks; i++) {
    const chunk: ExportChunk = {
      index: i,
      totalChunks,
      rows: input.rows.slice(i * chunkSize, (i + 1) * chunkSize),
    };
    await store.set(`export:job:${jobId}:chunk:${i}`, JSON.stringify(chunk));
    chunkCache.set(`${jobId}:${i}`, chunk);
  }

  // Record → job link.
  await store.set(`export:job:byrecord:${recordId}`, jobId);

  // Initial cursor handle (lastIndex -1, active, not completed).
  const handle: CursorHandle = {
    jobId,
    recordId,
    lastIndex: -1,
    status: "active",
    updatedAt: createdAt,
    completedAt: null,
  };
  await store.set(`export:cursor:${jobId}`, JSON.stringify(handle));

  jobCache.set(jobId, job);
  cursorHandleCache.set(jobId, handle);
  return job;
}

export async function getExportJob(jobId: string): Promise<ExportJob | null> {
  const cached = jobCache.get(jobId);
  if (cached) return cached;
  const raw = await getSharedStore()
    .get(`export:job:${jobId}`)
    .catch(() => null);
  if (!raw) return null;
  try {
    const job = JSON.parse(raw) as ExportJob;
    jobCache.set(jobId, job);
    return job;
  } catch {
    return null;
  }
}

export async function getExportChunk(
  jobId: string,
  index: number,
): Promise<ExportChunk | null> {
  const cacheKey = `${jobId}:${index}`;
  const cached = chunkCache.get(cacheKey);
  if (cached) return cached;
  const raw = await getSharedStore()
    .get(`export:job:${jobId}:chunk:${index}`)
    .catch(() => null);
  if (!raw) return null;
  try {
    const chunk = JSON.parse(raw) as ExportChunk;
    chunkCache.set(cacheKey, chunk);
    return chunk;
  } catch {
    return null;
  }
}

export async function getJobForRecord(recordId: string): Promise<string | null> {
  const raw = await getSharedStore()
    .get(`export:job:byrecord:${recordId}`)
    .catch(() => null);
  return raw ?? null;
}

/**
 * Rewrite the `export:cursor:${jobId}` handle with the new lastIndex/status.
 * Awaited by this function; the orchestrator wraps the call in `.catch` so a
 * transient write failure never breaks a chunk serve (the handle is
 * observability-only).
 */
export async function recordCursorProgress(
  jobId: string,
  index: number,
  status: ExportJobStatus,
): Promise<void> {
  const existing = cursorHandleCache.get(jobId);
  const recordId = existing?.recordId ?? "";
  const updatedAt = new Date().toISOString();
  const handle: CursorHandle = {
    jobId,
    recordId,
    lastIndex: index,
    status,
    updatedAt,
    completedAt: status === "completed" ? updatedAt : null,
  };
  await getSharedStore().set(`export:cursor:${jobId}`, JSON.stringify(handle));
  cursorHandleCache.set(jobId, handle);
}

export async function getCursorHandle(
  jobId: string,
): Promise<CursorHandle | null> {
  const cached = cursorHandleCache.get(jobId);
  if (cached) return cached;
  const raw = await getSharedStore()
    .get(`export:cursor:${jobId}`)
    .catch(() => null);
  if (!raw) return null;
  try {
    const handle = JSON.parse(raw) as CursorHandle;
    cursorHandleCache.set(jobId, handle);
    return handle;
  } catch {
    return null;
  }
}

/** Clear in-memory caches only (never the shared store). */
export function __resetExportJobStoreForTesting(): void {
  jobCache.clear();
  chunkCache.clear();
  cursorHandleCache.clear();
}
