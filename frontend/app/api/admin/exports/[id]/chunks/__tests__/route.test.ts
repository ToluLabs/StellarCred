// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { tmpdir } from "os";
import path from "path";
import {
  auditLogBootstrap,
  auditLogClear,
} from "@/lib/audit-log";
import { MemoryStore, setSharedStoreForTesting } from "@/lib/shared-store";
import { __resetExportStoreForTesting } from "@/lib/export-store";
import { __resetExportJobStoreForTesting } from "@/lib/export-job-store";
import { GET } from "../route";

const ORIGINAL_ADMIN_KEY = process.env.ADMIN_API_KEY;
const ORIGINAL_AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH;

function freshAuditPath(): string {
  return path.join(
    tmpdir(),
    `audit-784-route-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

function makeReq(headers: Record<string, string>): NextRequest {
  return new NextRequest(
    "http://localhost/api/admin/exports/unknown-record-id/chunks",
    { headers },
  );
}

describe("GET /api/admin/exports/[id]/chunks — auth gate", () => {
  beforeEach(async () => {
    setSharedStoreForTesting(new MemoryStore());
    __resetExportStoreForTesting();
    __resetExportJobStoreForTesting();
    process.env.ADMIN_API_KEY = "test-admin-key";
    const auditPath = freshAuditPath();
    process.env.AUDIT_LOG_PATH = auditPath;
    auditLogClear();
    await auditLogBootstrap(auditPath);
    auditLogClear();
  });

  afterEach(() => {
    setSharedStoreForTesting(null);
    if (ORIGINAL_ADMIN_KEY === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = ORIGINAL_ADMIN_KEY;
    if (ORIGINAL_AUDIT_LOG_PATH === undefined) delete process.env.AUDIT_LOG_PATH;
    else process.env.AUDIT_LOG_PATH = ORIGINAL_AUDIT_LOG_PATH;
    auditLogClear();
  });

  it("returns 401 with { error: 'Unauthorized' } when Authorization is missing", async () => {
    const res = await GET(makeReq({}), { params: Promise.resolve({ id: "unknown-record-id" }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 for an invalid Bearer token", async () => {
    const res = await GET(
      makeReq({ Authorization: "Bearer wrong-key" }),
      { params: Promise.resolve({ id: "unknown-record-id" }) },
    );
    expect(res.status).toBe(401);
  });

  it("passes the gate and reaches the orchestrator (valid key + unknown record → 404)", async () => {
    const res = await GET(
      makeReq({ Authorization: "Bearer test-admin-key" }),
      { params: Promise.resolve({ id: "unknown-record-id" }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("export not found");
  });
});
