import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

// The indexer's own default PORT (services/indexer/src/config.ts) when
// INDEXER_URL isn't set — matches local dev's default indexer address.
const DEFAULT_INDEXER_URL = "http://localhost:3001";

export interface IssuerStats {
  issuer: string;
  total: number;
  active: number;
  revoked: number;
  credential_types: string[];
  first_seen: number | null;
}

// Server-side proxy to the indexer's GET /issuers/:issuer/stats (#398) — kept
// server-side (rather than having the client fetch the indexer directly) so
// INDEXER_URL never needs a NEXT_PUBLIC_ prefix, matching /api/issuers'
// existing proxy-to-a-backend-service pattern.
export async function GET(req: NextRequest) {
  const issuer = req.nextUrl.searchParams.get("issuer");
  if (!issuer || issuer.trim() === "") {
    return NextResponse.json(
      { error: "issuer query parameter is required" },
      { status: 400 },
    );
  }

  const base = env.INDEXER_URL ?? DEFAULT_INDEXER_URL;
  try {
    const res = await fetch(
      `${base}/issuers/${encodeURIComponent(issuer.trim())}/stats`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: `indexer returned ${res.status}` },
        { status: 502 },
      );
    }
    const stats = (await res.json()) as IssuerStats;
    return NextResponse.json(stats);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 502 },
    );
  }
}
