// Framework-agnostic claim-gate core, shared by the Express and Next.js
// adapters. All the actual on-chain work — batching, per-read timeouts, and
// the fail-soft error taxonomy — lives in @stellarcred/sdk's `hasClaims`;
// this module only decides pass/fail and shapes the failure response.

import {
  hasClaims,
  buildVerifyUrl,
  type ClaimType,
  type BatchClaimOptions,
} from "@stellarcred/sdk";

/**
 * What to do when the caller's wallet is missing a required claim.
 *
 * - `"403"` (default) — respond with a JSON 403 describing which claims are
 *   missing. Appropriate for API routes / non-navigational requests.
 * - `"redirect"` — 302 the caller to a StellarCred verify link built with
 *   {@link buildVerifyUrl} for the first missing claim. Appropriate for
 *   page navigations.
 */
export type ClaimGateFailureMode = "403" | "redirect";

export interface ClaimGateOptions {
  /** One or more claim types the caller's wallet must hold. All are required (AND, not OR). */
  claims: readonly ClaimType[];
  /** Per-type minimum thresholds — same shape as {@link BatchClaimOptions.minThresholds}. */
  minThresholds?: BatchClaimOptions["minThresholds"];
  /** Restrict which issuer(s) every claim must come from. */
  trustedIssuers?: string[];
  /** Maximum time in milliseconds allowed for each on-chain read. */
  requestTimeoutMs?: number;
  /** Override the StellarCred base URL used to build the verify redirect. */
  baseUrl?: string;
  /**
   * What to do when one or more required claims are missing.
   * @default "403"
   */
  onFail?: ClaimGateFailureMode;
  /**
   * Where to send the caller back to after they verify, when `onFail` is
   * `"redirect"`. Required in that mode — omitted entirely in `"403"` mode.
   */
  returnUrl?: string;
}

export interface ClaimGateResult {
  /** `true` iff the wallet holds every requested claim. */
  ok: boolean;
  /** Per-type pass/fail, exactly as returned by `hasClaims`. */
  results: Partial<Record<ClaimType, boolean>>;
  /** The subset of `claims` that did not pass. Empty when `ok` is `true`. */
  missing: ClaimType[];
}

/**
 * Runs the batched claim check for one wallet against `options.claims`.
 * Framework adapters call this, then translate the result into a
 * pass-through / 403 / redirect response for their runtime.
 */
export async function evaluateClaimGate(
  wallet: string,
  options: Pick<ClaimGateOptions, "claims" | "minThresholds" | "trustedIssuers" | "requestTimeoutMs">,
): Promise<ClaimGateResult> {
  const results = await hasClaims(wallet, options.claims, {
    minThresholds: options.minThresholds,
    trustedIssuers: options.trustedIssuers,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const missing = options.claims.filter((c) => !results[c]);
  return { ok: missing.length === 0, results, missing };
}

/** Build the verify-link a failed gate redirects to, for the first missing claim. */
export function buildGateRedirectUrl(
  missing: ClaimType[],
  options: Pick<ClaimGateOptions, "returnUrl" | "baseUrl">,
): string {
  if (!options.returnUrl) {
    throw new Error(
      '@stellarcred/middleware: onFail: "redirect" requires `returnUrl` to be set.',
    );
  }
  return buildVerifyUrl({
    returnUrl: options.returnUrl,
    claim: missing[0],
    baseUrl: options.baseUrl,
  });
}

/** Shape of the JSON body sent for a 403 gate failure. */
export interface ClaimGateFailureBody {
  error: "insufficient_claims";
  required: ClaimType[];
  missing: ClaimType[];
}

export function buildGateFailureBody(
  required: readonly ClaimType[],
  missing: ClaimType[],
): ClaimGateFailureBody {
  return { error: "insufficient_claims", required: [...required], missing };
}

export function assertNonEmptyClaims(claims: readonly ClaimType[]): void {
  if (claims.length === 0) {
    throw new Error("@stellarcred/middleware: `claims` must include at least one claim type.");
  }
}
