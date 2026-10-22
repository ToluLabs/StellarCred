import { NextRequest, NextResponse } from "next/server";
import { getExportRecord } from "@/lib/export-store";
import { auditLogBootstrap } from "@/lib/audit-log";
import { checkAdminAuth, UNAUTHORIZED } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!checkAdminAuth(req)) {
    return NextResponse.json(UNAUTHORIZED, { status: 401 });
  }

  try {
    const { id } = await params;
    await auditLogBootstrap();
    // Note: can emit adminAction: 'inspect' once per-admin sessions are tracked
    const record = await getExportRecord(id);
    if (!record) {
      return NextResponse.json({ error: "export not found" }, { status: 404 });
    }
    return NextResponse.json({ export: record });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
