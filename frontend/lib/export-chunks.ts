/**
 * serveExportChunk — orchestrator for resumable chunked export downloads (#784).
 *
 * The route (`app/api/admin/exports/[id]/chunks/route.ts`) is a thin wrapper:
 * it enforces `checkAdminAuth`, calls `auditLogBootstrap`, parses params, and
 * serializes this function's result. All chunk/resume logic lives here so it is
 * independently unit-testable.
 *
 * Resumability: the resume cursor is the signed, self-contained token returned
 * as `nextCursor` — it survives a worker restart in the client's hands. The
 * persisted `CursorHandle` (in the shared store) is observability/progress-only.
 * A valid cursor after a restart resolves the job + chunk from the shared
 * store (memory caches miss → KV fallback), so the download continues without
 * recompute and without relying on in-memory state.
 */

import { auditLogAppend, auditLogPersist } from "./audit-log";
import {
  buildExportRows,
  createExportJob,
  DEFAULT_CHUNK_SIZE,
  getExportChunk,
  getExportJob,
  getJobForRecord,
  MAX_CHUNK_SIZE,
  recordCursorProgress,
  type ExportJob,
} from "./export-job-store";
import { getExportRecord } from "./export-store";
import { createCursor, verifyCursor } from "./export-cursor";
import { checkExportThrottle } from "./export-throttle";
import {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
} from "./export-concurrency";
import { enqueueExportJob, cancelQueuedJob } from "./export-scheduler";

export interface ServeChunkResult {
  status: number;
  body: Record<string, unknown>;
}

function auditAppendChunk(recordId: string, action: string): void {
  auditLogAppend({
    timestamp: Date.now(),
    requestId: crypto.randomUUID(),
    issuer: "admin", // PII-free constant; per-admin id awaits session support
    commitment: recordId, // PII-free record id
    adminAction: action, // "export:chunk" | "export:chunk:done"
  });
}

/**
 * Serve one chunk of an export's chunked download.
 *
 * - `cursor: null` (first call) resolves-or-creates the job for `recordId` and
 *   returns chunk 0 + `nextCursor`. Once a job exists for a record, no-cursor
 *   calls reuse it (chunk 0 is re-served); `limit` affects only the first job
 *   creation for a record.
 * - `cursor: <token>` returns the chunk at the token's index. The token's
 *   `jobId` is bound to `recordId` (cross-check), preventing cross-record use.
 *
 * `limit` is a creation-time hint only (rows per chunk); it is ignored on
 * cursor calls. Clamping to `[1, MAX_CHUNK_SIZE]` happens here, not in the route.
 *
 * ## Throttle + concurrency (first no-cursor call only — #788)
 *
 * When a new job must be created (no existing job for the record), this
 * function first checks the per-tenant rate limit and global concurrency cap.
 * - Rate-limit exceeded → 429 `export_rate_limited`
 * - Concurrency cap reached → 503 `export_concurrency_limit`
 *
 * The concurrency slot is acquired before `createExportJob` and released in a
 * `finally` block after the response body is built, so the slot is held for
 * the minimum time needed to create and immediately serve chunk 0.
 *
 * Cursor calls and reuse-path (existing job) bypass these checks entirely.
 */
export async function serveExportChunk(params: {
  recordId: string;
  cursor: string | null;
  limit: number | null;
}): Promise<ServeChunkResult> {
  const { recordId, cursor, limit } = params;

  // Revocation lives only on ExportRecord.revokedAt (set by #783's
  // revokeExportRecord). No job.status === "revoked" branch exists.
  const record = await getExportRecord(recordId);
  if (!record) {
    return { status: 404, body: { error: "export not found" } };
  }
  if (record.revokedAt) {
    return { status: 403, body: { error: "export revoked" } };
  }

  // -------------------------------------------------------------------------
  // Cursor path — no throttle/concurrency checks
  // -------------------------------------------------------------------------
  if (cursor) {
    const v = verifyCursor(cursor); // never throws
    if (!v.ok) {
      return { status: 400, body: { error: "invalid cursor", reason: v.reason } };
    }
    const job = await getExportJob(v.jobId); // null on miss; never throws to us
    if (!job) {
      return { status: 404, body: { error: "export job not found" } };
    }
    if (job.recordId !== recordId) {
      return {
        status: 400,
        body: { error: "cursor does not match this export" },
      };
    }
    if (v.index < 0 || v.index >= job.totalChunks) {
      return { status: 400, body: { error: "cursor out of range" } };
    }
    return serveChunkBody(job, v.index, false);
  }

  // -------------------------------------------------------------------------
  // No-cursor path
  // -------------------------------------------------------------------------
  const existingJobId = await getJobForRecord(recordId);
  const existing = existingJobId ? await getExportJob(existingJobId) : null;

  // Reuse path: job already exists — serve chunk 0 again without any throttle
  // or concurrency check (the gate was passed on the original first call).
  if (existing) {
    return serveChunkBody(existing, 0, true);
  }

  // First call: check throttle + concurrency before creating the job.
  const throttle = await checkExportThrottle(record.issuer);
  if (!throttle.allowed) {
    return {
      status: 429,
      body: {
        error: "export rate limit exceeded",
        code: "export_rate_limited",
        remaining: 0,
        resetAt: throttle.resetAt,
      },
    };
  }

  const slotAcquired = await acquireConcurrencySlot();
  if (!slotAcquired) {
    return {
      status: 503,
      body: {
        error: "export concurrency limit reached, try again later",
        code: "export_concurrency_limit",
      },
    };
  }

  // Slot is held from here. Release it in finally after the response is built.
  try {
    const job = await createExportJob({
      recordId,
      rows: buildExportRows(record),
      chunkSize: Math.max(
        1,
        Math.min(limit ?? DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE),
      ),
    });

    // Enqueue for admin observability — best-effort (errors must not fail the request).
    await enqueueExportJob({
      jobId: job.jobId,
      recordId,
      issuer: record.issuer,
      cost: 1,
      enqueuedAt: Date.now(),
    }).catch((e: unknown) =>
      console.warn(
        `[export-chunks] enqueueExportJob failed: ${(e as Error).message}`,
      ),
    );

    return await serveChunkBody(job, 0, true);
  } finally {
    // Best-effort cleanup — errors must not mask the response.
    await cancelQueuedJob(
      // resolvedJob may not be set if createExportJob threw; fall back to a
      // no-op cancel. cancelQueuedJob(unknown-id) returns false and is safe.
      await getJobForRecord(recordId).catch(() => null) ?? recordId,
    ).catch((e: unknown) =>
      console.warn(
        `[export-chunks] cancelQueuedJob failed: ${(e as Error).message}`,
      ),
    );
    await releaseConcurrencySlot().catch((e: unknown) =>
      console.warn(
        `[export-chunks] releaseConcurrencySlot failed: ${(e as Error).message}`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Internal chunk-body builder (shared by cursor and no-cursor paths)
// ---------------------------------------------------------------------------

/**
 * Fetch chunk `index` for `job`, build the progress handle, append audit
 * entries, and return the serialized result.
 *
 * @param isStart - true when this is the no-cursor (first) call for a record.
 */
async function serveChunkBody(
  job: ExportJob,
  index: number,
  isStart: boolean,
): Promise<ServeChunkResult> {
  // --- all throwy DATA steps run BEFORE any audit append (no orphan entry on
  //     a mid-flow throw). createCursor (only on non-final chunks) and any
  //     shared-store read are the only throwy steps here; both precede the
  //     first append. ---
  const chunk = await getExportChunk(job.jobId, index);
  if (!chunk) {
    console.warn(`chunk ${index} missing for job ${job.jobId}`);
    return { status: 404, body: { error: "chunk not found" } };
  }
  const nextIndex = index + 1;
  const done = nextIndex >= job.totalChunks;
  const nextCursor = done ? null : createCursor(job.jobId, nextIndex);

  // --- best-effort progress handle: observability-only. A transient write
  //     failure is swallowed + console.warn-logged and never turns a
  //     successfully-fetched chunk into a 500. The signed token (not the
  //     handle) drives resume. ---
  await recordCursorProgress(job.jobId, index, done ? "completed" : "active").catch(
    (e) =>
      console.warn(
        `cursor progress write failed for job ${job.jobId}: ${(e as Error).message}`,
      ),
  );

  // --- audit append + persist: only on start and/or done; `appended` gates
  //     the persist so intermediate chunks append nothing and skip the persist
  //     entirely. ---
  let appended = false;
  if (isStart) {
    auditAppendChunk(job.recordId, "export:chunk");
    appended = true;
  }
  if (done) {
    auditAppendChunk(job.recordId, "export:chunk:done");
    appended = true;
  }
  if (appended) {
    await auditLogPersist();
  }

  return {
    status: 200,
    body: {
      jobId: job.jobId,
      index,
      totalChunks: job.totalChunks,
      chunk,
      nextCursor,
      done,
    },
  };
}
