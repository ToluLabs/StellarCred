import { NextResponse } from "next/server";
import { outboundSinkStats } from "../../../lib/outbound-sink";

export const dynamic = "force-dynamic";

/** Stable service identifier reported to deployment and monitoring tooling. */
const SERVICE_NAME = "stellarcred-frontend";

/**
 * Liveness check: the Next.js process is up and serving requests. Always 200
 * while the process can respond; dependency readiness lives in /api/ready.
 * See docs/HEALTHCHECKS.md.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    ready: true,
    service: SERVICE_NAME,
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    outboundSink: outboundSinkStats(),
  });
}
