import { NextRequest, NextResponse } from "next/server";
import {
  auditLogBootstrap,
  auditLogEntries,
  auditLogVerify,
} from "@/lib/audit-log";
import { requireAdmin } from "@/app/api/_middleware";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  try {
    await auditLogBootstrap();

    const url = new URL(req.url);
    const issuerFilter = url.searchParams.get("issuer");
    const limitParam = url.searchParams.get("limit");

    let limit = 100;
    if (limitParam !== null) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 500);
      }
    }

    const allEntries = auditLogEntries();
    const { valid: chainValid, errors } = auditLogVerify();

    let filtered = allEntries;
    if (issuerFilter) {
      const lower = issuerFilter.toLowerCase();
      filtered = allEntries.filter((e) =>
        e.issuer.toLowerCase().includes(lower),
      );
    }

    // Take the most recent N after filtering
    const entries = filtered.slice(-limit);

    return NextResponse.json({ entries, chainValid, errors });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
