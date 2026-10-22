import { NextRequest, NextResponse } from "next/server";
import { auditLogBootstrap } from "@/lib/audit-log";
import { checkAdminAuth, UNAUTHORIZED } from "@/lib/admin-auth";
import { serveExportChunk } from "@/lib/export-chunks";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/exports/[id]/chunks — resumable chunked export download (#784).
 *
 * Query params:
 *   - cursor: optional signed token from a previous response's `nextCursor`.
 *     Absent → first call (chunk 0). Invalid → 400.
 *   - limit: optional integer > 0, used only at job creation as the rows-per-chunk
 *     size; clamped to [1, MAX_CHUNK_SIZE] inside `serveExportChunk`. Ignored on
 *     cursor calls. Defaults to DEFAULT_CHUNK_SIZE (100).
 *
 * Auth: `Authorization: Bearer <ADMIN_API_KEY>` (enforced here, before the
 * orchestrator runs). See lib/admin-auth.ts.
 */
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
    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor");
    const limitParam = url.searchParams.get("limit");
    let limit: number | null = null;
    if (limitParam !== null) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = parsed; // raw; serveExportChunk clamps to [1, MAX_CHUNK_SIZE]
      }
    }
    const result = await serveExportChunk({
      recordId: id,
      cursor,
      limit,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
