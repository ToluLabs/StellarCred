import { NextResponse, type NextRequest } from "next/server";
import type { ClaimType } from "@stellarcred/sdk";
import {
  evaluateClaimGate,
  buildGateRedirectUrl,
  buildGateFailureBody,
  assertNonEmptyClaims,
  type ClaimGateOptions,
} from "./core";

export interface NextClaimGateOptions extends ClaimGateOptions {
  /**
   * Resolve the caller's Stellar wallet address from the request. Required —
   * this only performs the read-only on-chain check; it does not
   * authenticate the caller. Wire it to whatever already establishes the
   * caller's wallet (a verified session cookie, a JWT, etc.) — never an
   * unauthenticated header or search param, since anyone can set those to
   * someone else's address.
   *
   * Return `null`/`undefined` for a request with no established wallet; it
   * is treated as failing every requested claim.
   */
  getWallet: (req: NextRequest) => string | null | undefined | Promise<string | null | undefined>;
}

async function resolveGate(req: NextRequest, options: NextClaimGateOptions) {
  assertNonEmptyClaims(options.claims);
  const wallet = (await options.getWallet(req)) ?? undefined;
  if (!wallet) {
    return { ok: false as const, missing: [...options.claims] };
  }
  const result = await evaluateClaimGate(wallet, options);
  return result.ok ? ({ ok: true as const, wallet, result } as const) : { ok: false as const, missing: result.missing };
}

function failureResponse(options: NextClaimGateOptions, missing: ClaimType[]) {
  if (options.onFail === "redirect") {
    const url = buildGateRedirectUrl(missing, options);
    return NextResponse.redirect(url, 302);
  }
  return NextResponse.json(buildGateFailureBody(options.claims, missing), { status: 403 });
}

/**
 * Build a `middleware.ts` claim gate for the Next.js Edge/Node middleware
 * runtime. Returns `NextResponse.next()` when the caller's wallet holds
 * every requested claim, otherwise a 403 JSON body or a redirect to the
 * StellarCred verify flow.
 *
 * @example
 * ```ts
 * // middleware.ts
 * import { createStellarCredMiddleware } from "@stellarcred/middleware/next";
 *
 * const gate = createStellarCredMiddleware({
 *   claims: ["kyc"],
 *   getWallet: (req) => req.cookies.get("wallet")?.value,
 *   onFail: "redirect",
 *   returnUrl: "https://myapp.example/vault",
 * });
 *
 * export function middleware(req: NextRequest) {
 *   return gate(req);
 * }
 *
 * export const config = { matcher: ["/vault/:path*"] };
 * ```
 */
export function createStellarCredMiddleware(options: NextClaimGateOptions) {
  assertNonEmptyClaims(options.claims);
  return async function stellarCredMiddleware(req: NextRequest): Promise<NextResponse> {
    const gate = await resolveGate(req, options);
    if (!gate.ok) return failureResponse(options, gate.missing);
    return NextResponse.next();
  };
}

/**
 * Wrap an App Router route handler so it only runs once the caller's wallet
 * holds every requested claim. Unlike {@link createStellarCredMiddleware},
 * this runs inside the route handler itself, so it works in `app/api/**`
 * and server route handlers without a top-level `middleware.ts`.
 *
 * @example
 * ```ts
 * // app/api/vault/route.ts
 * import { withStellarCredGate } from "@stellarcred/middleware/next";
 *
 * export const GET = withStellarCredGate(
 *   { claims: ["kyc", "funds"], minThresholds: { funds: 50000 }, getWallet: (req) => req.cookies.get("wallet")?.value },
 *   async (req, { wallet }) => Response.json({ ok: true, wallet }),
 * );
 * ```
 */
export function withStellarCredGate<Ctx = unknown>(
  options: NextClaimGateOptions,
  handler: (req: NextRequest, ctx: Ctx & { wallet: string }) => Response | Promise<Response>,
) {
  assertNonEmptyClaims(options.claims);
  return async (req: NextRequest, ctx?: Ctx): Promise<Response> => {
    const gate = await resolveGate(req, options);
    if (!gate.ok) return failureResponse(options, gate.missing);
    return handler(req, { ...(ctx as Ctx), wallet: gate.wallet });
  };
}
