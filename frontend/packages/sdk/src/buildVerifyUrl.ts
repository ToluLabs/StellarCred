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
import { getConfig, type ClaimType } from "./claims";

/**
 * Typed claim-specific parameters for {@link buildVerifyUrl}.
 */
export interface BuildVerifyUrlClaimParams {
  /**
   * Numeric threshold for financial credentials (`funds`, `income`, `accreditation`).
   * Can be supplied as a number or string (e.g. `50000` or `"50000"`).
   */
  threshold?: string | number;

  /**
   * Minimum age threshold in years for `age` credential proofs (e.g. `21` or `"21"`).
   * Can be supplied as a number or string.
   */
  threshold_years?: string | number;

  /**
   * Restricted ISO 3166-1 numeric country codes for `jurisdiction` credential proofs.
   * Can be an array of country codes (e.g. `["840", "364"]`) or a single code/comma-separated string.
   */
  restricted?: string | number | (string | number)[];

  /**
   * Optional evaluation mode (e.g. `"deny"` or `"allow"`).
   */
  mode?: string;

  /**
   * Additional or forward-compatible claim parameters.
   */
  [key: string]: unknown;
}

/**
 * Strongly typed options for {@link buildVerifyUrl}.
 */
export interface BuildVerifyUrlOptions {
  /**
   * Target URL where StellarCred will redirect the holder after the verification session completes.
   * StellarCred will append verification query parameters (`sc_verified`, `sc_wallet`, `sc_claims`, `sc_state`).
   *
   * Required. Can be an absolute URL (e.g. `"https://yourapp.xyz/callback"`) or relative path (e.g. `"/deposit"`).
   */
  returnUrl: string;

  /**
   * Single credential claim type to request (e.g. `"kyc"`, `"age"`, `"funds"`, `"income"`, `"jurisdiction"`, `"accreditation"`).
   */
  claim?: ClaimType;

  /**
   * Multiple credential claim types to request in a single verification session.
   */
  claims?: ClaimType[];

  /**
   * Optional holder wallet address (`G...`) to pre-fill or bind to the verification request.
   */
  wallet?: string;

  /**
   * Optional correlation or CSRF state token that will be passed back in the return URL (`sc_state`).
   */
  state?: string;

  /**
   * Base URL of the StellarCred web application.
   * Defaults to configured SDK `baseUrl` or `"https://stellarcred.xyz"`.
   */
  baseUrl?: string;

  /**
   * Link expiration duration in minutes from now.
   * When specified, an `exp` Unix timestamp (seconds) parameter is appended to the verification URL.
   * Must be a positive finite number.
   */
  expiresInMinutes?: number;

  /**
   * When true, generates a URL-safe single-use token ID (`jti`) embedded in the link.
   * The verify page consumes it on first use and prevents subsequent visits in the same session.
   */
  singleUse?: boolean;

  /**
   * Restricts accepted credential proofs to specific registered issuer public addresses.
   */
  trustedIssuers?: string[];

  /**
   * Claim-specific parameters such as threshold amount, age in years, or restricted country codes.
   */
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
 * Options specialized for KYC verification redirects.
 */
export type KycVerifyUrlOptions = Omit<BuildVerifyUrlOptions, "claim"> & {
  claim?: "kyc";
};

/**
 * Options specialized for age verification redirects requiring a minimum age.
 */
export type AgeVerifyUrlOptions = Omit<BuildVerifyUrlOptions, "claim" | "claimParams"> & {
  claim: "age";
  claimParams: BuildVerifyUrlClaimParams & {
    threshold_years: string | number;
  };
};

/**
 * Options specialized for threshold financial claims (funds, income, accreditation).
 */
export type ThresholdVerifyUrlOptions = Omit<BuildVerifyUrlOptions, "claim" | "claimParams"> & {
  claim: "funds" | "income" | "accreditation";
  claimParams: BuildVerifyUrlClaimParams & {
    threshold: string | number;
  };
};

/**
 * Options specialized for jurisdiction verification redirects with restricted country codes.
 */
export type JurisdictionVerifyUrlOptions = Omit<BuildVerifyUrlOptions, "claim" | "claimParams"> & {
  claim: "jurisdiction";
  claimParams: BuildVerifyUrlClaimParams & {
    restricted: string | number | (string | number)[];
  };
};

/**
 * Builds a strongly typed StellarCred verification redirect URL.
 *
 * Redirecting an unverified user to this URL opens the StellarCred verification flow.
 * After verifying (or cancelling), StellarCred redirects back to `returnUrl` with
 * query parameters:
 * - `sc_verified`: `"true"` if verification succeeded
 * - `sc_wallet`: The holder's wallet address
 * - `sc_claims`: Comma-separated list of claim types issued in this session
 * - `sc_state`: Roundtrips the `state` parameter if supplied
 *
 * ⚠️ SECURITY NOTICE:
 * Parameters in the redirect URL are UNTRUSTED HINTS. Anyone can construct a URL with
 * arbitrary parameters. Always verify wallet control via challenge signature and
 * confirm on-chain credentials via `hasClaim` / `verifyWalletClaim` before granting access.
 *
 * @param opts Verification redirect URL options
 * @returns The fully constructed verification URL string
 *
 * @throws {Error} If `returnUrl` is missing or empty.
 * @throws {Error} If `expiresInMinutes` is not a positive finite number.
 * @throws {Error} If `singleUse` is true but no crypto implementation is available.
 *
 * @example
 * // Basic KYC redirect
 * const url = buildVerifyUrl({
 *   returnUrl: "https://yourapp.xyz/dashboard",
 *   claim: "kyc",
 * });
 *
 * @example
 * // Age verification requiring 21+
 * const url = buildVerifyUrl({
 *   returnUrl: "https://yourapp.xyz/app",
 *   claim: "age",
 *   claimParams: { threshold_years: 21 },
 * });
 *
 * @example
 * // Funds verification requiring >= $50,000 balance
 * const url = buildVerifyUrl({
 *   returnUrl: "https://yourapp.xyz/vault",
 *   claim: "funds",
 *   claimParams: { threshold: 50_000 },
 * });
 *
 * @example
 * // Jurisdiction gate blocking specific ISO 3166-1 numeric country codes
 * const url = buildVerifyUrl({
 *   returnUrl: "https://yourapp.xyz/trade",
 *   claim: "jurisdiction",
 *   claimParams: { restricted: ["840", "364"] },
 * });
 *
 * @example
 * // Single-use, time-limited verification link
 * const url = buildVerifyUrl({
 *   returnUrl: "https://yourapp.xyz/callback",
 *   claim: "kyc",
 *   expiresInMinutes: 15,
 *   singleUse: true,
 *   state: "sess_xyz123",
 * });
 */
export function buildVerifyUrl(opts: BuildVerifyUrlOptions): string {
  if (!opts || typeof opts.returnUrl !== "string" || !opts.returnUrl.trim()) {
    throw new Error("buildVerifyUrl: 'returnUrl' is required and must be a non-empty string");
  }

  let base = opts.baseUrl;
  if (!base) {
    try {
      base = getConfig()?.baseUrl;
    } catch {
      // ignore
    }
  }
  if (!base) {
    const proc =
      typeof process !== "undefined"
        ? (process.env as Record<string, string | undefined>)
        : undefined;
    base =
      proc?.STELLARCRED_BASE_URL ||
      proc?.NEXT_PUBLIC_STELLARCRED_BASE_URL ||
      "https://stellarcred.xyz";
  }

  const url = new URL("/verify", base);
  url.searchParams.set("return_url", opts.returnUrl);

  if (opts.claim) {
    url.searchParams.set("claim", opts.claim);
  }
  if (opts.claims && opts.claims.length > 0) {
    url.searchParams.set("claims", opts.claims.join(","));
  }
  if (opts.wallet) {
    url.searchParams.set("wallet", opts.wallet);
  }
  if (opts.state) {
    url.searchParams.set("state", opts.state);
  }
  if (opts.trustedIssuers && opts.trustedIssuers.length > 0) {
    url.searchParams.set("trusted_issuers", opts.trustedIssuers.join(","));
  }

  if (opts.claimParams) {
    const cp = opts.claimParams;
    if (cp.threshold !== undefined && cp.threshold !== null && cp.threshold !== "") {
      const val = String(cp.threshold);
      url.searchParams.set("param_threshold", val);
      url.searchParams.set("threshold", val);
    }
    if (
      cp.threshold_years !== undefined &&
      cp.threshold_years !== null &&
      cp.threshold_years !== ""
    ) {
      const val = String(cp.threshold_years);
      url.searchParams.set("param_threshold_years", val);
      url.searchParams.set("threshold_years", val);
    }
    if (cp.restricted !== undefined && cp.restricted !== null) {
      const restricted = Array.isArray(cp.restricted)
        ? cp.restricted.map(String).join(",")
        : String(cp.restricted);
      if (restricted.length > 0) {
        url.searchParams.set("param_restricted", restricted);
        url.searchParams.set("restricted", restricted);
      }
    }
    if (cp.mode) {
      url.searchParams.set("mode", String(cp.mode));
    }

    for (const [key, value] of Object.entries(cp)) {
      if (["threshold", "threshold_years", "restricted", "mode"].includes(key)) continue;
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
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
      jti = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    } else {
      throw new Error(
        "singleUse requires a crypto implementation with randomUUID or getRandomValues",
      );
    }
    url.searchParams.set("jti", jti);
  }

  return url.toString();
}
