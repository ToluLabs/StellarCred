/**
 * examples/server-side-gate/index.ts
 *
 * Minimal SDK integration snippets showing server-side credential gating
 * and wallet-control verification.
 *
 * ⚠️ NOTE ON WALLET SPOOFING (Issue #543):
 * Never rely solely on an untrusted wallet address in request headers or return URLs.
 * Always require the caller to sign a challenge via `verifyWalletClaim` to prove
 * wallet control before granting access.
 *
 * FOR THE COMPLETE RUNNABLE EXAMPLE APPLICATION:
 * See `examples/canonical-integration/` — a complete, runnable application with
 * interactive UI, automated test suite, route gating, and failure state handling.
 */

// ─── 1. Configure at startup (call once, e.g. in instrumentation.ts) ─────────

import StellarCred, {
  configure,
  hasClaim,
  buildVerifyUrl,
  parseReturnParams,
  createWalletChallenge,
  verifyWalletClaim,
} from "@stellarcred/sdk";

// Option A: configure explicitly
configure({
  registryId: process.env.STELLARCRED_REGISTRY_ID ?? "",
  rpcUrl:
    process.env.STELLARCRED_RPC_URL ?? "https://soroban-testnet.stellar.org",
});

// Option B: set env vars and skip configure() — the SDK picks them up
// automatically if STELLARCRED_REGISTRY_ID and STELLARCRED_RPC_URL are set.
// Call healthCheck() at startup to confirm configuration before serving traffic.

const health = StellarCred.healthCheck();
if (!health.configured) {
  console.error("[StellarCred] misconfigured — missing:", health.missing);
  // Don't crash; gates will deny access until the config is fixed.
}

// ─── 2. Simple KYC gate ───────────────────────────────────────────────────────

/**
 * Enforce that the requesting wallet holds a valid KYC credential.
 * Drop this into any API route / middleware that requires identity verification.
 *
 * Usage (Next.js App Router):
 *
 *   export async function GET(request: Request) {
 *     const wallet = request.headers.get("x-wallet-address") ?? "";
 *     const gate = await kycGate(wallet, request.url);
 *     if (gate) return gate; // 302 → /verify or 403
 *     // proceed with verified request
 *     return Response.json({ data: "secret" });
 *   }
 */
export async function kycGate(
  wallet: string,
  currentUrl: string
): Promise<Response | null> {
  if (!wallet) {
    return new Response(JSON.stringify({ error: "No wallet address provided" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const verified = await hasClaim(wallet, "kyc");

  if (!verified) {
    // Redirect unverified users to StellarCred, with this page as the return URL
    const verifyUrl = buildVerifyUrl({
      claim: "kyc",
      returnUrl: currentUrl,
    });
    return Response.redirect(verifyUrl, 302);
  }

  return null; // wallet is KYC-verified — let the request through
}

// ─── 3. Funds gate with minThreshold and trusted issuers ─────────────────────

/**
 * Enforce that the wallet has proved a balance ≥ $50,000 from a specific issuer.
 *
 * `minThreshold` ensures the on-chain proof was generated with at least this
 * threshold — a proof for "balance ≥ 200,000" satisfies minThreshold: 50_000,
 * but a proof for "balance ≥ 10,000" does not.
 *
 * `trustedIssuers` further narrows which issuer signed the underlying credential.
 */
export async function fundsGate(
  wallet: string,
  currentUrl: string,
  {
    minBalance = 50_000,
    trustedIssuers,
  }: { minBalance?: number; trustedIssuers?: string[] } = {}
): Promise<Response | null> {
  if (!wallet) {
    return new Response(JSON.stringify({ error: "Wallet address required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const verified = await hasClaim(wallet, "funds", {
    minThreshold: minBalance,
    trustedIssuers,
  });

  if (!verified) {
    const verifyUrl = buildVerifyUrl({
      claim: "funds",
      returnUrl: currentUrl,
      claimParams: { threshold: String(minBalance) },
    });
    return Response.redirect(verifyUrl, 302);
  }

  return null;
}

// ─── 4. Handling the return redirect from StellarCred ────────────────────────

/**
 * Called in the route that receives the user back from /verify.
 *
 * ⚠️ SECURITY CRITICAL (Issue #543):
 * `sc_verified=true` and `sc_wallet` in the return URL are UNTRUSTED HINTS.
 * Anyone can visit your return URL passing another person's verified wallet address.
 * Never grant access solely by calling `hasClaim(hint.wallet)`.
 *
 * Secure pattern:
 *  1. Parse untrusted hints with `parseReturnParams`.
 *  2. Require client to sign a challenge via `verifyWalletClaim` to prove wallet control.
 *  3. Only grant session access when both wallet control AND on-chain claim are valid.
 *
 * Usage (Next.js App Router):
 *
 *   export async function POST(request: Request) {
 *     return secureHandleVerifyReturn(request);
 *   }
 */
export async function secureHandleVerifyReturn(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const { wallet, challenge, signature } = body;

  if (!wallet || !challenge || !signature) {
    return new Response(
      JSON.stringify({
        error: "Missing wallet control proof (wallet, challenge, signature required)",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Atomically validates signature AND checks on-chain claim
  const result = await verifyWalletClaim({
    wallet,
    challenge,
    signature,
    claim: "kyc",
  });

  if (!result.ok) {
    return new Response(
      JSON.stringify({
        error: result.error,
        failureReason: result.failureReason,
        signatureValid: result.signatureValid,
        claimValid: result.claimValid,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  // Grant authenticated session
  return new Response(
    JSON.stringify({
      ok: true,
      wallet: result.wallet,
      claimDetails: result.claimDetails,
      message: "Access granted — caller proved wallet control AND valid on-chain KYC",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ─── 5. Age-gate example ─────────────────────────────────────────────────────

/** Require wallet to have proved age ≥ 21. */
export async function ageGate(
  wallet: string,
  currentUrl: string,
  minAge = 21
): Promise<Response | null> {
  const verified = await hasClaim(wallet, "age", { minThreshold: minAge });
  if (!verified) {
    return Response.redirect(
      buildVerifyUrl({
        claim: "age",
        returnUrl: currentUrl,
        claimParams: { threshold_years: String(minAge) },
      }),
      302
    );
  }
  return null;
}

// ─── 6. Composable multi-claim gate ─────────────────────────────────────────

/**
 * Require ALL of the listed claims to be verified. Returns the first failing
 * gate response, or null if all pass.
 *
 * @example
 * const block = await allClaimsGate(wallet, url, ["kyc", { type: "funds", minThreshold: 50_000 }]);
 * if (block) return block;
 */
type ClaimRequirement =
  | string
  | { type: string; minThreshold?: number; trustedIssuers?: string[] };

export async function allClaimsGate(
  wallet: string,
  currentUrl: string,
  claims: ClaimRequirement[]
): Promise<Response | null> {
  for (const req of claims) {
    const type = typeof req === "string" ? req : req.type;
    const opts = typeof req === "string" ? undefined : { minThreshold: req.minThreshold, trustedIssuers: req.trustedIssuers };
    const ok = await hasClaim(wallet, type, opts);
    if (!ok) {
      return Response.redirect(
        buildVerifyUrl({ claim: type, returnUrl: currentUrl }),
        302
      );
    }
  }
  return null;
}
