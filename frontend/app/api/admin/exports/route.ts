import { NextRequest, NextResponse } from "next/server";
import { listExportRecords } from "@/lib/export-store";
import { auditLogBootstrap } from "@/lib/audit-log";
import { requireAdmin } from "@/app/api/_middleware";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

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
