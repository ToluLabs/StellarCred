import { NextRequest, NextResponse } from "next/server";
import { listExportRecords } from "@/lib/export-store";
import { auditLogBootstrap } from "@/lib/audit-log";
import { checkAdminAuth, UNAUTHORIZED } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!checkAdminAuth(req)) {
    return NextResponse.json(UNAUTHORIZED, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const limitParam = url.searchParams.get("limit");
    let limit = 100;
    if (limitParam !== null) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 500);
      }
    }

    await auditLogBootstrap();
    // Note: per-admin session tracking would allow emitting an audit event here
    // with adminAction: 'list'. Skipped until admin session support is added.
    const records = await listExportRecords(limit);
    return NextResponse.json({ exports: records });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
