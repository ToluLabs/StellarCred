// @stellarcred/sdk/server
//
// Server-only re-export of the StellarCred SDK.
//
// Import from this entry point when you intend to call hasClaim() /
// getClaims() exclusively from a server environment (Node.js, Next.js route
// handlers, edge workers, etc.). It throws at import time if it detects a
// browser context, providing a clear signal that the import crossed the
// client/server boundary unintentionally.
//
// Usage:
//
//   // In a Next.js route handler or server action:
//   import StellarCred from "@stellarcred/sdk/server";
//
//   export async function GET(req: Request) {
//     const wallet = new URL(req.url).searchParams.get("wallet") ?? "";
//     const ok = await StellarCred.hasClaim(wallet, "kyc");
//     return Response.json({ ok });
//   }
//
// For client-side usage, import from "@stellarcred/sdk" instead.

if (typeof window !== "undefined") {
  throw new Error(
    "@stellarcred/sdk/server must only be used server-side. " +
      "It is designed for Node.js route handlers, server actions, and edge " +
      "workers where hasClaim() reads are performed before granting access. " +
      "For client-side claim checks, import from \"@stellarcred/sdk\" instead.",
  );
}

export * from "./index";
export { default } from "./index";
