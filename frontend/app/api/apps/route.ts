import { NextResponse } from "next/server";
import { listApprovedApps } from "@/lib/apps-store";
import rawDemoProtocols from "@/data/demo-protocols.json";

export const dynamic = "force-dynamic";

export async function GET() {
  // Fetch approved community / third-party apps from the store (indexer or local fallback).
  let apps: unknown[] = [];
  try {
    apps = await listApprovedApps();
  } catch {
    // Store unavailable — fall through with an empty list.
  }

  return NextResponse.json({
    // Demo protocols are served alongside community apps so the UI can render
    // them immediately even when the indexer is unreachable.
    // The `isDemo: true` field lets consumers visually distinguish them from
    // real integrations submitted via the #433 submission flow.
    demos: rawDemoProtocols,
    apps,
  });
}
