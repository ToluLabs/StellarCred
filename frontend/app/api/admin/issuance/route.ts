import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/api/_middleware";
import { listIssuanceQueue, type QueueStatusFilter } from "@/lib/issuance-queue";

export const dynamic = "force-dynamic";

const STATUSES: QueueStatusFilter[] = ["all", "pending", "failed", "resolved"];

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const p = new URL(req.url).searchParams;
  const status = (p.get("status") ?? "all") as QueueStatusFilter;
  if (!STATUSES.includes(status)) {
    return NextResponse.json({ error: "invalid status filter" }, { status: 400 });
  }
  const records = listIssuanceQueue({
    status,
    provider: p.get("provider") ?? undefined,
    search: p.get("search") ?? undefined,
  });
  return NextResponse.json({ records });
}
