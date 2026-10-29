import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/app/api/_middleware";
import { retryIssuance, resolveIssuance } from "@/lib/issuance-queue";
import { auditLogAppend, auditLogBootstrap, auditLogPersist } from "@/lib/audit-log";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  let body: { action?: unknown; actor?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const actor = typeof body.actor === "string" ? body.actor.trim() : "";
  if (!actor) return NextResponse.json({ error: "actor is required" }, { status: 400 });
  if (body.action !== "retry" && body.action !== "resolve") {
    return NextResponse.json({ error: "action must be retry or resolve" }, { status: 400 });
  }

  const id = decodeURIComponent(params.id);
  const result = body.action === "retry" ? retryIssuance(id) : resolveIssuance(id, actor);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.code === "not_found" ? 404 : 409 },
    );
  }

  await auditLogBootstrap();
  auditLogAppend({
    timestamp: Date.now(),
    requestId: crypto.randomUUID(),
    issuer: actor,
    commitment: id,
    adminAction: `issuance_${body.action}`,
  });
  await auditLogPersist();
  return NextResponse.json({ record: result.record });
}
