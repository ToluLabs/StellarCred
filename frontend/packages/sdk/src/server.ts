/**
 * @stellarcred/sdk/server
 *
 * Server-side entry point for the StellarCred read-only SDK.
 *
 * Import from this path when you are verifying claims in a Node.js / Edge
 * runtime (API routes, middleware, server components, Lambda handlers, etc.).
 * Importing from here makes the intent explicit at the call site and suppresses
 * the dev-mode client/server boundary warning that fires when configure() is
 * called from a browser with server-only environment variable names.
 *
 * All exports are identical to `@stellarcred/sdk` — this is a thin re-export.
 * The distinction is documentation and tooling intent, not runtime behaviour.
 *
 * @example
 * // Next.js API route (app router)
 * import StellarCred from "@stellarcred/sdk/server";
 *
 * export async function GET(req: Request) {
 *   const wallet = new URL(req.url).searchParams.get("wallet") ?? "";
 *   const ok = await StellarCred.hasClaim(wallet, "kyc");
 *   return Response.json({ verified: ok });
 * }
 *
 * @example
 * // Express middleware
 * import { hasClaim } from "@stellarcred/sdk/server";
 *
 * app.use(async (req, res, next) => {
 *   const ok = await hasClaim(req.user.wallet, "kyc");
 *   if (!ok) return res.status(403).json({ error: "KYC required" });
 *   next();
 * });
 *
 * Trust boundary:
 *  • The ProofRegistry contract ID (registryId) and RPC URL are read-only
 *    infrastructure config — safe to put in NEXT_PUBLIC_* vars for the
 *    browser SDK too. They are not secrets.
 *  • The ISSUER_PRIVATE_KEY used by @stellarcred/issuer is a secret and must
 *    NEVER appear in browser-side config. Keep it in server-only env vars
 *    (no NEXT_PUBLIC_ prefix) and never pass it to the SDK.
 *  • Claim checks performed server-side are the authoritative gate.
 *    Client-side checks (useSStellarCred, hasClaim in the browser) are for
 *    optimistic UI only — always re-verify server-side before granting access.
 */
export * from "./index";
export { default } from "./index";
