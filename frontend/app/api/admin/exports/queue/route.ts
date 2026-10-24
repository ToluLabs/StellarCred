import { NextRequest, NextResponse } from "next/server";
import { checkAdminAuth, UNAUTHORIZED } from "@/lib/admin-auth";
import { getExportMetrics } from "@/lib/export-metrics";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!checkAdminAuth(req)) {
    return NextResponse.json(UNAUTHORIZED, { status: 401 });
  }

  try {
    const metrics = await getExportMetrics();
    return NextResponse.json({
      activeJobs: metrics.activeJobs,
      queueDepth: metrics.queueDepth,
      queuedJobs: metrics.queuedJobs,
      maxConcurrent: metrics.maxConcurrent,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
