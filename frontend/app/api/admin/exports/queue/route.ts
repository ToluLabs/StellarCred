import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/api/_middleware";
import { getExportMetrics } from "@/lib/export-metrics";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

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
