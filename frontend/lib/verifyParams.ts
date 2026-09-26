/**
 * lib/verifyParams.ts
 *
 * Pure validation helpers for /verify query params.
 * Extracted so they can be unit-tested independently of the React component.
 */

import { CREDENTIAL_TYPES, type CredentialType } from "./stellar";
import type { ClaimParams } from "./credential";

/** Credential types the circuit set supports. Keep in sync with TYPE_META. */
export const VALID_CLAIM_TYPES = [
  "kyc",
  "age",
  "income",
  "jurisdiction",
  "funds",
  "accreditation",
] as const;
export type ValidClaimType = (typeof VALID_CLAIM_TYPES)[number];

/** ISO 3166-1 numeric codes are 1–999. */
const ISO_NUMERIC_RE = /^\d{1,3}$/;

/**
 * Validate a return_url supplied as a query param.
 *
 * Rules:
 * - Relative paths (starting with `/`) are always accepted (same-origin redirect).
 * - Absolute URLs must use `https:` or `http:` (blocks javascript:, data:, etc.).
 * - `http:` is allowed only when the redirect target is the same origin as the
 *   current page (e.g. localhost dev setups).
 * - Never pass external return_url values to router.push — use window.location.href.
 *
 * @returns `{ ok: true }` on success, `{ ok: false, error: string }` on failure.
 */
export function validateReturnUrl(
  returnUrl: string,
  currentOrigin?: string
): { ok: true } | { ok: false; error: string } {
  if (!returnUrl) return { ok: true }; // no return_url is fine — will fall back to /holder

  // Relative same-origin paths are always safe
  if (returnUrl.startsWith("/")) {
    return { ok: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(returnUrl);
  } catch {
    return { ok: false, error: "Invalid return URL: must be a well-formed URL." };
  }

  // Only http: and https: are allowed — block javascript:, data:, blob:, etc.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      error: `Invalid return URL: "${parsed.protocol}" scheme is not allowed. Use https://.`,
    };
  }

  // Allow http: only when the redirect stays on the same origin (e.g. localhost)
  if (parsed.protocol === "http:") {
    const origin = currentOrigin ?? (typeof window !== "undefined" ? window.location.origin : "");
    if (origin && parsed.origin !== origin) {
      return {
        ok: false,
        error: "Invalid return URL: external http:// URLs are not allowed. Use https://.",
      };
    }
  }

  return { ok: true };
}

/**
 * Validate the `claim` query param.
 * Returns `null` when the claim is missing or invalid (caller should fall back to default).
 */
export function validateClaimParam(
  claim: string | null | undefined
): ValidClaimType | null {
  if (!claim) return null;
  return (VALID_CLAIM_TYPES as readonly string[]).includes(claim)
    ? (claim as ValidClaimType)
    : null;
}

/**
 * Validate a numeric threshold param (`threshold_years`, `threshold`).
 *
 * @param raw   Raw query-param string value.
 * @param opts  Optional min/max constraints.
 * @returns `{ ok: true, value: number }` or `{ ok: false, error: string }`.
 */
export function validateNumericParam(
  raw: string | null | undefined,
  opts: { name: string; min?: number; max?: number; integer?: boolean } = { name: "value" }
): { ok: true; value: number } | { ok: false; error: string } | { ok: true; value: undefined } {
  if (raw == null || raw === "") return { ok: true, value: undefined };

  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    return { ok: false, error: `Invalid ${opts.name}: must be a number, got "${raw}".` };
  }
  if (opts.integer !== false && !Number.isInteger(n)) {
    return { ok: false, error: `Invalid ${opts.name}: must be a whole number, got "${raw}".` };
  }
  const min = opts.min ?? 1;
  if (n < min) {
    return { ok: false, error: `Invalid ${opts.name}: must be ≥ ${min}, got ${n}.` };
  }
  if (opts.max !== undefined && n > opts.max) {
    return { ok: false, error: `Invalid ${opts.name}: must be ≤ ${opts.max}, got ${n}.` };
  }
  return { ok: true, value: n };
}

/**
 * Validate the `restricted` query param (comma-separated ISO 3166-1 numeric codes).
 *
 * Constraints:
 * - At most 8 entries (circuit hard limit: `RESTRICTED_LEN = 8`).
 * - Each entry must be a 1–3 digit numeric string (ISO 3166-1 numeric).
 *
 * @returns `{ ok: true, codes: string[] }` or `{ ok: false, error: string }`.
 */
export function validateRestrictedList(
  raw: string | null | undefined
): { ok: true; codes: string[] } | { ok: false; error: string } {
  if (!raw) return { ok: true, codes: [] };

  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);

  if (entries.length > 8) {
    return {
      ok: false,
      error: `Invalid restricted list: at most 8 country codes allowed, got ${entries.length}.`,
    };
  }

  const invalid = entries.filter((e) => !ISO_NUMERIC_RE.test(e));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid restricted list: entries must be numeric ISO 3166-1 codes (1–3 digits). Invalid: ${invalid.slice(0, 5).join(", ")}.`,
    };
  }

  return { ok: true, codes: entries };
}

/** Collect all param validation errors for the /verify page in one call. */
export function validateVerifyParams(params: {
  returnUrl: string | null;
  claim: string | null;
  thresholdYears: string | null;
  threshold: string | null;
  restricted: string | null;
  currentOrigin?: string;
}): {
  returnUrlError: string | null;
  claimError: string | null;
  thresholdYearsError: string | null;
  thresholdError: string | null;
  restrictedError: string | null;
  hasErrors: boolean;
} {
  const returnUrlResult = validateReturnUrl(
    params.returnUrl ?? "",
    params.currentOrigin
  );

  const claimError =
    params.claim && !(VALID_CLAIM_TYPES as readonly string[]).includes(params.claim)
      ? `Unknown credential type "${params.claim}". Supported: ${VALID_CLAIM_TYPES.join(", ")}.`
      : null;

  const tyResult = validateNumericParam(params.thresholdYears, {
    name: "threshold_years",
    min: 1,
    max: 150,
  });

  const tResult = validateNumericParam(params.threshold, {
    name: "threshold",
    min: 1,
  });

  const rResult = validateRestrictedList(params.restricted);

  const returnUrlError = returnUrlResult.ok ? null : returnUrlResult.error;
  const thresholdYearsError = tyResult.ok ? null : (tyResult as { ok: false; error: string }).error;
  const thresholdError = tResult.ok ? null : (tResult as { ok: false; error: string }).error;
  const restrictedError = rResult.ok ? null : rResult.error;

  return {
    returnUrlError,
    claimError,
    thresholdYearsError,
    thresholdError,
    restrictedError,
    hasErrors: !!(returnUrlError ?? claimError ?? thresholdYearsError ?? thresholdError ?? restrictedError),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseVerifyParams — structured parsing for /verify verification links
// (added in #299; coexist with the validate* helpers above, which the verify
// page uses for inline field-level errors).
// ─────────────────────────────────────────────────────────────────────────────

export type VerifyErrorCode =
  | "missing_return_url"
  | "bad_claim"
  | "bad_threshold"
  | "bad_restricted"
  | "bad_return_url";

export interface VerifyError {
  code: VerifyErrorCode;
  /** Short heading shown at the top of the error panel. */
  title: string;
  /** Human-friendly explanation of exactly what is wrong. */
  detail: string;
}

export interface ParsedVerifyParams {
  ok: boolean;
  /**
   * True when the link intends to be a protocol verification link (i.e. it
   * carried any verification params). When false this is a self-service visit
   * that keeps the current behaviour.
   */
  isVerificationLink: boolean;
  /** Validated, open-redirect-free return URL (https, or site-relative). */
  returnUrl?: string;
  /** Validated claim type, or null when absent / not a protocol link. */
  requiredClaim?: CredentialType | null;
  /** Normalised proof parameters to carry into the issued credential. */
  claimParams?: ClaimParams;
  /** Persona resume id, when present. */
  inquiryId?: string;
  /** When ok is false, describes why the link is invalid. */
  error?: VerifyError;
}

/** Claim types that carry a numeric threshold in their proof params. */
const THRESHOLD_CLAIMS: CredentialType[] = ["age", "income", "funds", "accreditation"];

const VALID_CLAIM_SET = new Set<string>(CREDENTIAL_TYPES);

function isCredentialType(value: string | undefined): value is CredentialType {
  return value !== undefined && VALID_CLAIM_SET.has(value);
}

/** A non-negative integer, matching how the circuits consume thresholds. */
function isNonNegativeInteger(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/.test(value);
}

/**
 * Validate a return URL. Accepts https URLs and site-relative paths only
 * (never http, javascript:, or a fully-qualified non-https URL).
 */
export function isValidReturnUrl(returnUrl: string): boolean {
  if (returnUrl.startsWith("/")) return true;
  try {
    const parsed = new URL(returnUrl);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse and validate the /verify query string. Returns either a usable result
 * or a specific VerifyError describing what makes the link invalid.
 */
export function parseVerifyParams(search: {
  return_url?: string | null;
  claim?: string | null;
  threshold_years?: string | null;
  threshold?: string | null;
  min_threshold?: string | null;
  restricted?: string | null;
  inquiry_id?: string | null;
}): ParsedVerifyParams {
  // Coerce all raw search params to string | undefined once, so the rest of
  // the function only deals with a single nullable flavour.
  const return_url = search.return_url ?? undefined;
  const inquiry_id = search.inquiry_id ?? undefined;
  const claim = search.claim ?? undefined;
  const threshold_years = search.threshold_years ?? undefined;
  const threshold = search.threshold ?? undefined;
  const min_threshold = search.min_threshold ?? undefined;
  const restricted = search.restricted ?? undefined;

  // A verification link is identifiable by carrying at least one verification
  // parameter. A plain /verify visit, or a Persona resume (?inquiry-id=…), has
  // none and is treated as self-service.
  const hasVerificationParams = [
    return_url,
    claim,
    threshold_years,
    threshold,
    min_threshold,
    restricted,
  ].some((v) => v !== undefined && v !== "");

  // Self-service / Persona resume: not a protocol link, nothing to validate.
  if (!hasVerificationParams) {
    return {
      ok: true,
      isVerificationLink: false,
      requiredClaim: null,
      inquiryId: inquiry_id,
    };
  }

  // ── Verification link — a return_url is mandatory for a protocol to get the
  // user back. Missing it means the link was truncated / malformed.
  if (!return_url) {
    return {
      ok: false,
      isVerificationLink: true,
      requiredClaim: null,
      inquiryId: inquiry_id,
      error: {
        code: "missing_return_url",
        title: "This verification link is missing its return URL",
        detail:
          "A valid verification link must say where to bring you back after you verify. Ask the service that sent you here for a fresh link.",
      },
    };
  }

  if (!isValidReturnUrl(return_url)) {
    return {
      ok: false,
      isVerificationLink: true,
      requiredClaim: null,
      inquiryId: inquiry_id,
      error: {
        code: "bad_return_url",
        title: "This verification link has an invalid return URL",
        detail:
          "The return URL must be a secure (https) web address or a path on this site. It may have been truncated or corrupted.",
      },
    };
  }

  // ── claim type must be one we actually support.
  if (claim !== undefined && !isCredentialType(claim)) {
    return {
      ok: false,
      isVerificationLink: true,
      requiredClaim: null,
      inquiryId: inquiry_id,
      error: {
        code: "bad_claim",
        title: "\u201c" + claim + "\u201d is not a credential we support",
        detail:
          "The link asked for an unrecognised credential type. Supported types are: " +
          CREDENTIAL_TYPES.join(", ") +
          ". Try a fresh verification link from the service.",
      },
    };
  }

  // ── Threshold params must be non-negative integers where applicable.
  const isThresholdClaim = claim !== undefined && THRESHOLD_CLAIMS.includes(claim);
  const primaryThreshold =
    claim === "age" ? (threshold_years ?? min_threshold) : (threshold ?? min_threshold);
  if (isThresholdClaim && primaryThreshold !== undefined && !isNonNegativeInteger(primaryThreshold)) {
    return {
      ok: false,
      isVerificationLink: true,
      requiredClaim: null,
      inquiryId: inquiry_id,
      error: {
        code: "bad_threshold",
        title: "This claim threshold is invalid",
        detail:
          "The " +
          claim +
          " gate expects a whole-number threshold (for example \u201c21\u201d or \u201c50000\u201d), but got \u201c" +
          primaryThreshold +
          "\u201d. The link may be malformed.",
      },
    };
  }

  // ── restricted list must be numeric country codes.
  if (restricted !== undefined && restricted !== "") {
    const codes = restricted.split(",").map((s) => s.trim());
    if (codes.some((c) => !/^\d{1,4}$/.test(c))) {
      return {
        ok: false,
        isVerificationLink: true,
        requiredClaim: null,
        inquiryId: inquiry_id,
        error: {
          code: "bad_restricted",
          title: "The restricted-countries list is malformed",
          detail:
            "The restricted parameter should be numeric country codes separated by commas (for example \u201c840,364\u201d).",
        },
      };
    }
  }

  // Normalise claimParams so only fields that apply to the requested claim are
  // carried through (unused fields are omitted entirely).
  const cleanClaimParams: ClaimParams = {};
  if (claim === "age") {
    if (primaryThreshold !== undefined) cleanClaimParams.threshold_years = primaryThreshold;
  } else if (claim !== undefined && THRESHOLD_CLAIMS.includes(claim)) {
    if (primaryThreshold !== undefined) cleanClaimParams.threshold = primaryThreshold;
  }
  if (claim !== undefined && claim === "jurisdiction" && restricted) {
    const restrictedCodes = restricted.split(",").map((s) => s.trim()).filter(Boolean);
    if (restrictedCodes.length > 0) cleanClaimParams.restricted = restrictedCodes.sort();
  }

  return {
    ok: true,
    isVerificationLink: true,
    returnUrl: return_url,
    requiredClaim: (claim as CredentialType) ?? null,
    claimParams: cleanClaimParams,
    inquiryId: inquiry_id,
  };
}
