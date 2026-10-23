import { NextRequest, NextResponse } from "next/server";
import { revokeExportRecord } from "@/lib/export-store";
import {
  auditLogBootstrap,
  auditLogAppend,
  auditLogPersist,
} from "@/lib/audit-log";
import { checkAdminAuth, UNAUTHORIZED } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!checkAdminAuth(req)) {
    return NextResponse.json(UNAUTHORIZED, { status: 401 });
  }

  try {
    const { id } = await params;

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "request body must be valid JSON" },
        { status: 400 },
      );
    }

    const { revokedBy } = body ?? {};
    if (!revokedBy || typeof revokedBy !== "string" || !revokedBy.trim()) {
      return NextResponse.json(
        { error: "revokedBy is required" },
        { status: 400 },
      );
    }

    const record = await revokeExportRecord(id, revokedBy.trim());
    if (!record) {
      return NextResponse.json({ error: "export not found" }, { status: 404 });
    }

    await auditLogBootstrap();
    auditLogAppend({
      timestamp: Date.now(),
      requestId: crypto.randomUUID(),
      issuer: revokedBy.trim(),
      commitment: id,
      adminAction: "revoke",
    });
    await auditLogPersist();

    return NextResponse.json({ success: true, record });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
