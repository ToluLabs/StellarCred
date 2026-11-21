// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import {
  createExportRecord,
  listExportRecords,
  getExportRecord,
  revokeExportRecord,
  __resetExportStoreForTesting,
} from "./export-store";

const base = {
  issuer: "GISS1234ISSUER",
  commitment: "0xabc123commitment",
  credentialType: "kyc",
  requestedAt: new Date().toISOString(),
  artifactUrl: null,
  metadata: {},
};

describe("export-store", () => {
  beforeEach(() => {
    __resetExportStoreForTesting();
  });

  it("createExportRecord creates a record with correct fields and null revokedAt/revokedBy", async () => {
    const record = await createExportRecord(base);
    expect(record.id).toBeTruthy();
    expect(typeof record.id).toBe("string");
    expect(record.issuer).toBe(base.issuer);
    expect(record.commitment).toBe(base.commitment);
    expect(record.credentialType).toBe(base.credentialType);
    expect(record.requestedAt).toBe(base.requestedAt);
    expect(record.revokedAt).toBeNull();
    expect(record.revokedBy).toBeNull();
  });

  it("createExportRecord twice produces two records with different ids", async () => {
    const r1 = await createExportRecord(base);
    const r2 = await createExportRecord({ ...base, requestedAt: new Date(Date.now() + 1).toISOString() });
    expect(r1.id).not.toBe(r2.id);
  });

  it("listExportRecords returns records sorted by requestedAt descending", async () => {
    const t0 = "2024-01-01T00:00:00.000Z";
    const t1 = "2024-06-01T00:00:00.000Z";
    const t2 = "2024-12-01T00:00:00.000Z";
    await createExportRecord({ ...base, requestedAt: t1 });
    await createExportRecord({ ...base, requestedAt: t0 });
    await createExportRecord({ ...base, requestedAt: t2 });

    const records = await listExportRecords();
    expect(records[0].requestedAt).toBe(t2);
    expect(records[1].requestedAt).toBe(t1);
    expect(records[2].requestedAt).toBe(t0);
  });

  it("listExportRecords respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await createExportRecord({ ...base, requestedAt: new Date(i * 1000).toISOString() });
    }
    const records = await listExportRecords(3);
    expect(records).toHaveLength(3);
  });

  it("getExportRecord returns null for unknown id", async () => {
    const result = await getExportRecord("unknown-id");
    expect(result).toBeNull();
  });

  it("getExportRecord returns the record after creation", async () => {
    const record = await createExportRecord(base);
    const fetched = await getExportRecord(record.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(record.id);
    expect(fetched?.issuer).toBe(base.issuer);
  });

  it("revokeExportRecord sets revokedAt and revokedBy", async () => {
    const record = await createExportRecord(base);
    const revoked = await revokeExportRecord(record.id, "admin-alice");
    expect(revoked).not.toBeNull();
    expect(revoked?.revokedBy).toBe("admin-alice");
    expect(revoked?.revokedAt).toBeTruthy();
    expect(typeof revoked?.revokedAt).toBe("string");
  });

  it("revokeExportRecord returns null for unknown id", async () => {
    const result = await revokeExportRecord("no-such-id", "admin");
    expect(result).toBeNull();
  });

  it("getExportRecord reflects revocation after revokeExportRecord", async () => {
    const record = await createExportRecord(base);
    await revokeExportRecord(record.id, "admin-bob");
    const fetched = await getExportRecord(record.id);
    expect(fetched?.revokedBy).toBe("admin-bob");
    expect(fetched?.revokedAt).toBeTruthy();
  });

  it("__resetExportStoreForTesting clears state (list returns empty after reset)", async () => {
    await createExportRecord(base);
    __resetExportStoreForTesting();
    const records = await listExportRecords();
    expect(records).toHaveLength(0);
  });
});
