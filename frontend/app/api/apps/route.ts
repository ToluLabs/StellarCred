import { NextResponse } from "next/server";
import { listApprovedApps } from "@/lib/apps-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const apps = await listApprovedApps();
    return NextResponse.json({ apps });
  } catch {
    return NextResponse.json({ apps: [] }, { status: 200 });
  }
}
