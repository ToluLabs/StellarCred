// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MemoryStore,
  setSharedStoreForTesting,
} from "./shared-store";
import {
  buildExportRows,
  createExportJob,
  getCursorHandle,
  getExportChunk,
  getExportJob,
  getJobForRecord,
  recordCursorProgress,
  __resetExportJobStoreForTesting,
  type ExportRow,
} from "./export-job-store";
import { __resetExportStoreForTesting } from "./export-store";

function makeRows(n: number): ExportRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `rec-1`,
    field: `f${i}`,
    value: `v${i}`,
  }));
}

describe("export-job-store", () => {
  beforeEach(() => {
    setSharedStoreForTesting(new MemoryStore());
    __resetExportJobStoreForTesting();
    __resetExportStoreForTesting();
  });

  afterEach(() => {
    setSharedStoreForTesting(null);
  });

  it("createExportJob splits 250 rows / chunkSize 100 into 3 chunks, last has 50 rows", async () => {
    const job = await createExportJob({
      recordId: "rec-1",
      rows: makeRows(250),
      chunkSize: 100,
    });
    expect(job.totalChunks).toBe(3);
    expect(job.totalRows).toBe(250);
    expect(job.chunkSize).toBe(100);
    expect(job.status).toBe("active");
    const last = await getExportChunk(job.jobId, 2);
    expect(last?.rows).toHaveLength(50);
  });

  it("createExportJob with empty rows yields 1 chunk with 0 rows", async () => {
    const job = await createExportJob({
      recordId: "rec-1",
      rows: [],
    });
    expect(job.totalChunks).toBe(1);
    expect(job.totalRows).toBe(0);
    const chunk = await getExportChunk(job.jobId, 0);
    expect(chunk?.rows).toEqual([]);
  });

  it("getExportChunk returns the right rows per index, in order; null for unknown job/index", async () => {
    const job = await createExportJob({
      recordId: "rec-1",
      rows: makeRows(5),
      chunkSize: 2,
    });
    expect(job.totalChunks).toBe(3);
    const c0 = await getExportChunk(job.jobId, 0);
    const c1 = await getExportChunk(job.jobId, 1);
    const c2 = await getExportChunk(job.jobId, 2);
    expect(c0?.rows.map((r) => r.field)).toEqual(["f0", "f1"]);
    expect(c1?.rows.map((r) => r.field)).toEqual(["f2", "f3"]);
    expect(c2?.rows.map((r) => r.field)).toEqual(["f4"]);
    expect(await getExportChunk("unknown-job", 0)).toBeNull();
    expect(await getExportChunk(job.jobId, 99)).toBeNull();
  });

  it("getExportJob returns metadata; null for unknown id", async () => {
    const job = await createExportJob({
      recordId: "rec-1",
      rows: makeRows(10),
    });
    const fetched = await getExportJob(job.jobId);
    expect(fetched?.jobId).toBe(job.jobId);
    expect(fetched?.totalChunks).toBe(1);
    expect(await getExportJob("nope")).toBeNull();
  });

  it("getJobForRecord returns the jobId after creation; null before", async () => {
    expect(await getJobForRecord("rec-1")).toBeNull();
    const job = await createExportJob({
      recordId: "rec-1",
      rows: makeRows(10),
    });
    expect(await getJobForRecord("rec-1")).toBe(job.jobId);
  });

  it("recordCursorProgress + getCursorHandle round-trip; completedAt set when completed", async () => {
    const job = await createExportJob({
      recordId: "rec-1",
      rows: makeRows(10),
    });
    await recordCursorProgress(job.jobId, 0, "active");
    const h1 = await getCursorHandle(job.jobId);
    expect(h1?.lastIndex).toBe(0);
    expect(h1?.status).toBe("active");
    expect(h1?.completedAt).toBeNull();
    await recordCursorProgress(job.jobId, 1, "completed");
    const h2 = await getCursorHandle(job.jobId);
    expect(h2?.lastIndex).toBe(1);
    expect(h2?.status).toBe("completed");
    expect(h2?.completedAt).toBeTruthy();
  });

  it("cursor handle persists across an in-memory reset", async () => {
    const job = await createExportJob({
      recordId: "rec-1",
      rows: makeRows(20),
    });
    await recordCursorProgress(job.jobId, 0, "active");
    __resetExportJobStoreForTesting(); // clears caches; shared store intact
    const h = await getCursorHandle(job.jobId); // reads from shared store
    expect(h?.lastIndex).toBe(0);
    expect(h?.jobId).toBe(job.jobId);
  });

  it("buildExportRows emits the exact ordered rows for a fully-set record", () => {
    const record = {
      id: "rec-1",
      issuer: "GISS",
      commitment: "0xabc",
      credentialType: "kyc",
      requestedAt: "2026-01-01T00:00:00.000Z",
      revokedAt: "2026-02-01T00:00:00.000Z",
      revokedBy: "admin-1",
      artifactUrl: "https://example.com/a.json",
      metadata: { source: "plaid", region: "eu" },
    };
    const rows = buildExportRows(record);
    expect(rows.map((r) => r.field)).toEqual([
      "issuer",
      "commitment",
      "credentialType",
      "requestedAt",
      "revokedAt",
      "revokedBy",
      "artifactUrl",
      "metadata.source",
      "metadata.region",
    ]);
    expect(rows.map((r) => r.value)).toEqual([
      "GISS",
      "0xabc",
      "kyc",
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "admin-1",
      "https://example.com/a.json",
      "plaid",
      "eu",
    ]);
    expect(rows.every((r) => r.id === "rec-1")).toBe(true);
  });

  it("buildExportRows emits value:\"\" for null optional fields", () => {
    const record = {
      id: "rec-2",
      issuer: "GISS",
      commitment: "0xdef",
      credentialType: "age",
      requestedAt: "2026-01-01T00:00:00.000Z",
      revokedAt: null,
      revokedBy: null,
      artifactUrl: null,
      metadata: {},
    };
    const rows = buildExportRows(record);
    const byField = Object.fromEntries(rows.map((r) => [r.field, r.value]));
    expect(byField.revokedAt).toBe("");
    expect(byField.revokedBy).toBe("");
    expect(byField.artifactUrl).toBe("");
    expect(rows).toHaveLength(7);
  });
});
