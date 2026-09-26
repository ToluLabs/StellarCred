/**
 * @stellarcred/sdk/server
 *
 * Server-side entry point for @stellarcred/sdk.
 *
 * ─── Why import from here instead of "@stellarcred/sdk"? ─────────────────────
 *
 * The main SDK entry point is safe in both browser and server contexts. This
 * sub-path exists to make server intent explicit at the import site, so:
 *
 *   1. Code reviewers and automated tooling (import boundary rules, ESLint
 *      no-restricted-imports, etc.) can flag the import if it appears in a
 *      client component or browser bundle — "@stellarcred/sdk/server" in a
 *      client-only file is a clear signal that something is wrong.
 *
 *   2. The module will emit a visible warning if it is accidentally imported
 *      in a browser — unlike the main entry point, which is designed for
 *      client use and stays quiet unless config values look server-only.
 *
 * ─── Trust boundary ──────────────────────────────────────────────────────────
 *
 * The SDK itself is read-only and safe in browsers — it only makes free
 * simulated calls to the Stellar RPC, never touches secrets or signs anything.
 * However, when you use the SDK on the server to gate access to protected
 * resources, the re-verification call itself is the security boundary:
 *
 *   • Never trust the sc_verified / sc_wallet query params from a StellarCred
 *     return redirect alone — those are advisory hints, not authenticated
 *     claims. Always call hasClaim() on the server with the wallet address
 *     the user presented to your backend (from your own session, not from
 *     the URL) before granting access.
 *
 *   • Keep your ProofRegistry contract ID (STELLARCRED_REGISTRY_ID) as an
 *     environment variable WITHOUT a NEXT_PUBLIC_ prefix if you only use the
 *     SDK server-side — there is no reason to expose the registry ID to the
 *     browser in a pure server-gating pattern.
 *
 *   • The one value that genuinely must be server-only is ISSUER_PRIVATE_KEY
 *     (used by @stellarcred/issuer, not this package). The SDK has no private
 *     keys and cannot sign anything.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 * ```ts
 * // In a Next.js Route Handler, tRPC router, or Express middleware:
 * import { hasClaim, configure } from "@stellarcred/sdk/server";
 *
 * configure({ registryId: process.env.STELLARCRED_REGISTRY_ID });
 *
 * export async function GET(req: Request) {
 *   const wallet = getSessionWallet(req); // from your own auth session
 *   const ok = await hasClaim(wallet, "kyc");
 *   if (!ok) return new Response("Forbidden", { status: 403 });
 *   // ...
 * }
 * ```
 *
 * All exports here are identical to the main entry point — this sub-path adds
 * no new behaviour, only explicit import-site documentation of server intent.
 */

// Emit a visible warning if this module is accidentally loaded in a browser.
if (typeof window !== "undefined") {
  // eslint-disable-next-line no-console
  console.warn(
    "[StellarCred] @stellarcred/sdk/server was imported in a browser context. " +
      "This entry point is intended for server-side use only (Node.js, edge runtimes, " +
      "Next.js Route Handlers / Server Actions / middleware). " +
      "If you need to call hasClaim() in a browser component, import from " +
      '"@stellarcred/sdk" instead. ' +
      "See the SDK README — \"Trust boundary\" section — for details.",
  );
}

// Re-export everything from the main entry point unchanged.
export * from "./index";
export { default } from "./index";
