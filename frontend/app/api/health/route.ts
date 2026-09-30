import { NextResponse } from "next/server";
import { outboundSinkStats } from "../../../lib/outbound-sink";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ status: "ok", outboundSink: outboundSinkStats() });
}
