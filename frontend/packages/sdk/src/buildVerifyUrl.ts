import type { ClaimType } from "./claims";

export interface BuildVerifyUrlClaimParams {
  threshold?: string;
  threshold_years?: string;
  restricted?: string | readonly string[];
}

export interface BuildVerifyUrlOptions {
  /** URL that receives the user after verification. */
  returnUrl: string;
  /** One claim required by the verification flow. */
  claim?: ClaimType;
  /** Multiple claims required by the verification flow. */
  claims?: readonly ClaimType[];
  /** Optional wallet to prefill on the verification page. */
  wallet?: string;
  /** Opaque state returned to the caller; do not put secrets in this value. */
  state?: string;
  /** Override the configured StellarCred app origin. */
  baseUrl?: string;
  /** Link lifetime. Must be a positive finite number when provided. */
  expiresInMinutes?: number;
  /** Add a random token that can be consumed only once. */
  singleUse?: boolean;
  /** Claim-specific public policy parameters. */
  claimParams?: BuildVerifyUrlClaimParams;
}

/**
 * Build a StellarCred verification URL.
 *
 * `defaultBaseUrl` is supplied by the SDK wrapper from `configure()`; direct
 * callers may instead pass `baseUrl` in the options.
 */
export function buildVerifyUrl(opts: BuildVerifyUrlOptions, defaultBaseUrl?: string): string {
  const base = opts.baseUrl ?? defaultBaseUrl ?? "https://stellarcred.xyz";
  const url = new URL("/verify", base);
  url.searchParams.set("return_url", opts.returnUrl);

  if (opts.claim) url.searchParams.set("claim", opts.claim);
  if (opts.claims && opts.claims.length > 0) {
    url.searchParams.set("claims", opts.claims.join(","));
  }
  if (opts.wallet) url.searchParams.set("wallet", opts.wallet);
  if (opts.state) url.searchParams.set("state", opts.state);
  if (opts.claimParams) {
    if (opts.claimParams.threshold) {
      url.searchParams.set("param_threshold", opts.claimParams.threshold);
    }
    if (opts.claimParams.threshold_years) {
      url.searchParams.set("param_threshold_years", opts.claimParams.threshold_years);
    }
    if (opts.claimParams.restricted) {
      const restricted =
        typeof opts.claimParams.restricted === "string"
          ? opts.claimParams.restricted
          : [...opts.claimParams.restricted].join(",");
      url.searchParams.set("param_restricted", restricted);
    }
  }

  if (opts.expiresInMinutes !== undefined) {
    if (!Number.isFinite(opts.expiresInMinutes) || opts.expiresInMinutes <= 0) {
      throw new Error("expiresInMinutes must be a positive number");
    }
    const exp = Math.floor(Date.now() / 1000) + Math.floor(opts.expiresInMinutes * 60);
    url.searchParams.set("exp", String(exp));
  }

  if (opts.singleUse) {
    let jti: string;
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      jti = crypto.randomUUID().replace(/-/g, "");
    } else if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      jti = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    } else {
      throw new Error(
        "singleUse requires a crypto implementation with randomUUID or getRandomValues",
      );
    }
    url.searchParams.set("jti", jti);
  }

  return url.toString();
}
