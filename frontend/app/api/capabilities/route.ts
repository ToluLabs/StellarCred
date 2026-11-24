import { NextResponse } from "next/server";

import {
  buildCapabilitiesDescriptor,
  CAPABILITIES_CACHE_CONTROL,
} from "../../../lib/capabilities";

export const dynamic = "force-dynamic";

/**
 * GET /api/capabilities — machine-readable capability descriptor (issue #639).
 *
 * A single well-known URL an integrator (or @stellarcred/sdk's
 * `StellarCred.bootstrap()`) can fetch to configure itself: network, contract
 * IDs and on-chain versions, supported credential types, registered-issuer
 * summary, public indexer URL (when configured), sponsored-submission
 * availability, and the SDK version range known to work.
 *
 * Public and cacheable — the payload contains nothing sensitive. CORS is
 * open (`*`) for this path via middleware.ts so any site can bootstrap.
 * The values must agree with the DEPLOYMENTS.md registry record for the
 * deployment (see scripts/verify-capabilities.mjs).
 */
export async function GET() {
  const descriptor = await buildCapabilitiesDescriptor();
  return NextResponse.json(descriptor, {
    headers: { "Cache-Control": CAPABILITIES_CACHE_CONTROL },
  });
}
