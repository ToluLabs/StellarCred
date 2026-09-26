import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:3001";

export async function GET() {
  try {
    const res = await fetch(`${INDEXER_URL}/apps`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return NextResponse.json({ apps: [] }, { status: 200 });
    }

    const data = await res.json();
    return NextResponse.json({ apps: data.apps ?? [] });
  } catch {
    return NextResponse.json({ apps: [] }, { status: 200 });
  }
}
