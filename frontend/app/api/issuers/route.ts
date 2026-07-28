import { NextResponse } from "next/server";
import { fetchRegisteredIssuers } from "@/lib/issuer-registry";

// Any existing account works for read-only Soroban simulation.
const SIM_ACCOUNT =
  process.env.NEXT_PUBLIC_ISSUER_ADDRESS ??
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export async function GET() {
  try {
    const issuers = await fetchRegisteredIssuers(SIM_ACCOUNT);
    return NextResponse.json({ issuers });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, issuers: [] }, { status: 500 });
  }
}
