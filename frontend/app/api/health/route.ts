import { NextResponse } from "next/server";
import { outboundSinkStats } from "../../../lib/outbound-sink";

export const dynamic = "force-dynamic";

/** Stable service identifier used by deployment and monitoring tooling. */
const SERVICE_NAME = "stellarcred-frontend";

/**
 * Resolve the deployed application version.
 *
 * `NEXT_PUBLIC_APP_VERSION` is stamped by the release pipeline (see
 * DEPLOYMENTS.md); outside a release build it falls back to the package
 * version so the field is always a non-empty string.
 */
function resolveVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "dev";
}

/**
 * GET /api/health — liveness + lightweight readiness probe for the frontend.
 *
 * Returns a machine-readable summary that deployment and monitoring tooling
 * can poll: overall `status`, the `service` name, `version` metadata, and a
 * `ready` flag. It performs no dependency I/O, so it always answers quickly
 * and is safe to poll at a high frequency; a 200 means the Next.js server is
 * running and able to serve requests. Use `/api/ready` for the deep
 * dependency readiness checks (RPC, signer, contracts, Persona) before
 * routing production traffic. See docs/HEALTHCHECKS.md for the full contract.
 */
export async function GET() {
  const version = resolveVersion();
  const outboundSink = outboundSinkStats();

  return NextResponse.json(
    {
      status: "ok",
      ready: true,
      service: SERVICE_NAME,
      version,
      app_version: version,
      timestamp: Date.now(),
      uptime_seconds: Math.round(process.uptime()),
      outboundSink,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
