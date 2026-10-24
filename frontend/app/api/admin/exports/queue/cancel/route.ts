import { NextRequest, NextResponse } from "next/server";
import { checkAdminAuth, UNAUTHORIZED } from "@/lib/admin-auth";
import { cancelQueuedJob } from "@/lib/export-scheduler";
import {
  auditLogBootstrap,
  auditLogAppend,
  auditLogPersist,
} from "@/lib/audit-log";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!checkAdminAuth(req)) {
    return NextResponse.json(UNAUTHORIZED, { status: 401 });
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "request body must be valid JSON" },
        { status: 400 },
      );
    }

    const { jobId } = body ?? {};
    if (!jobId || typeof jobId !== "string" || !jobId.trim()) {
      return NextResponse.json(
        { error: "jobId is required" },
        { status: 400 },
      );
    }

    const cancelled = await cancelQueuedJob(jobId.trim());
    if (!cancelled) {
      return NextResponse.json(
        { error: "job not found in queue" },
        { status: 404 },
      );
    }

    await auditLogBootstrap();
    auditLogAppend({
      timestamp: Date.now(),
      requestId: crypto.randomUUID(),
      issuer: "admin",
      commitment: jobId.trim(),
      adminAction: "export:cancel",
    });
    await auditLogPersist();

    return NextResponse.json({ success: true, jobId: jobId.trim() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
