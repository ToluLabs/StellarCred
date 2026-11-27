import { NextResponse } from "next/server";
import { classifyVerificationError } from "@/packages/sdk/src/errors";
import { fetchRegisteredIssuers } from "@/lib/issuer-registry";
import { env } from "@/lib/env";

// Any existing account works for read-only Soroban simulation.
const SIM_ACCOUNT =
  env.NEXT_PUBLIC_ISSUER_ADDRESS ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export async function GET() {
  try {
    const issuers = await fetchRegisteredIssuers(SIM_ACCOUNT);
    return NextResponse.json({ issuers });
  } catch (e) {
    const error = classifyVerificationError(e, {
      fallbackCategory: "network_error",
      fallbackCode: "issuer_read_failed",
    });
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        category: error.category,
        retryable: error.retryable,
        issuers: [],
      },
      { status: 500 },
    );
  }
}
