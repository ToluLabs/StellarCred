/**
 * Wallet-signed presentation tokens for server-side verification (#1062).
 *
 * Next.js App Router Server Components run on the server, where browser wallet
 * extensions are unavailable. A holder's client can package the credentials it
 * wants to present into a compact, wallet-signed token; a Server Component (or
 * API route, middleware, Lambda, or any other server handler) then verifies
 * that token without a round trip through a custom API endpoint.
 *
 * ## Token format
 *
 * ```text
 * scpt1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
 * ```
 *
 * The signature is an Ed25519 signature by `payload.wallet` over:
 *
 * ```text
 * stellarcred/presentation-token/v1\n<base64url(payload JSON)>
 * ```
 *
 * The domain prefix prevents a signature produced for another StellarCred
 * purpose from being replayed as a presentation token. Signing the encoded
 * payload (rather than a re-serialized object) means verification does not
 * depend on JSON key ordering or normalization.
 *
 * ## Security model
 *
 * 1. The envelope and payload are validated before any value is trusted.
 * 2. The Ed25519 signature is verified with the SDK's existing
 *    {@link verifyWalletSignature} implementation, proving the presenter
 *    controls `payload.wallet`.
 * 3. `expiresAt` bounds replay: tokens are short-lived (five minutes by
 *    default) and an optional `nonce` lets the caller implement single-use
 *    bookkeeping if it needs stronger replay protection.
 * 4. Unless `verifyClaims: false` is explicitly passed, every presented claim
 *    is re-checked against ProofRegistry with the existing `hasClaim` /
 *    `checkClaimStatus` logic. A token can never assert a credential that the
 *    wallet does not actually hold on-chain.
 *
 * ## Runtime compatibility
 *
 * This module is safe for both the Node.js and Edge runtimes. It does not
 * access `window`, `document`, `localStorage`, `sessionStorage`, wallet
 * extensions, or any `node:` built-in. Encoding uses only `TextEncoder` /
 * `TextDecoder` (available in Node.js and workers) and a small pure-JavaScript
 * base64url codec, and cryptography is delegated to the existing
 * `@stellar/stellar-sdk`-based signature helper.
 *
 * @example
 * ```tsx
 * // app/dashboard/page.tsx — Next.js App Router Server Component
 * import { cookies } from "next/headers";
 * import { verifyPresentationToken } from "@stellarcred/sdk/server";
 *
 * export default async function Dashboard() {
 *   const token = (await cookies()).get("sc_presentation")?.value;
 *   const result = await verifyPresentationToken(token ?? "", {
 *     requiredClaims: ["kyc"],
 *     audience: "app.example.com",
 *   });
 *
 *   if (!result.ok) return <p>Access denied: {result.error}</p>;
 *   return <p>Welcome, KYC-verified {result.wallet}</p>;
 * }
 * ```
 */

import { verifyWalletSignature } from "./challenge";
import {
  checkClaimStatus,
  hasClaim,
  isValidClaimType,
  normalizeAndValidateWallet,
  type ClaimOptions,
  type ClaimType,
  type CredentialStatusResult,
} from "./claims";

/** Envelope prefix identifying a StellarCred presentation token. */
export const PRESENTATION_TOKEN_PREFIX = "scpt1";

/** Only token payload version understood by this SDK release. */
export const PRESENTATION_TOKEN_VERSION = 1;

/** Default token lifetime: five minutes from `issuedAt`. */
export const DEFAULT_PRESENTATION_TOKEN_TTL_SECONDS = 5 * 60;

/** Default clock skew tolerated during expiry checks. */
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;

const SIGNING_DOMAIN = "stellarcred/presentation-token/v1";
const MAX_TOKEN_LENGTH = 8 * 1024;
const MAX_PRESENTED_CLAIMS = 16;
const SIGNATURE_BYTES = 64;

/**
 * Claims and holder packaged into a presentation token. Every field is covered
 * by the token signature.
 */
export interface PresentationTokenPayload {
  /** Payload format version. */
  v: typeof PRESENTATION_TOKEN_VERSION;
  /** Stellar public key (G...) of the holder presenting the credentials. */
  wallet: string;
  /** Credential claim types the holder is presenting. Always non-empty. */
  claims: ClaimType[];
  /** Unix timestamp in seconds when the token was signed. */
  issuedAt: number;
  /** Unix timestamp in seconds after which the token is invalid. */
  expiresAt?: number;
  /**
   * Optional audience (for example the relying application's domain). When
   * `verifyPresentationToken` is given an `audience`, the two must match.
   */
  audience?: string;
  /**
   * Optional random nonce. Verification does not consume it; callers that need
   * strict single-use semantics can record it themselves.
   */
  nonce?: string;
}

/** Input accepted by {@link createPresentationToken}. */
export interface CreatePresentationTokenParams {
  /** Stellar public key (G...) that will sign the token. */
  wallet: string;
  /** Claim types to present. At least one; duplicates are rejected. */
  claims: readonly ClaimType[];
  /** Unix timestamp in seconds. Defaults to the current time. */
  issuedAt?: number;
  /**
   * Unix timestamp in seconds. Defaults to `issuedAt + 300` so tokens are
   * short-lived by default.
   */
  expiresAt?: number;
  /** Optional audience bound into the signed payload. */
  audience?: string;
  /**
   * Optional replay-protection nonce. When omitted a random nonce is generated
   * if the runtime exposes `crypto.randomUUID`; otherwise the token simply has
   * no nonce and relies on `expiresAt`.
   */
  nonce?: string;
  /**
   * Signs the UTF-8 message with the holder's Ed25519 key. Return a 64-byte
   * signature as hex, base64, base64url, or raw bytes. Wallet integrations
   * typically call `signMessage(message)` and return its `signedMessage`.
   */
  sign: (message: string) => string | Uint8Array | Promise<string | Uint8Array>;
}

/** Options that tighten or relax {@link verifyPresentationToken}. */
export interface VerifyPresentationTokenOptions {
  /** Claim types the caller requires. The token must present all of them. */
  requiredClaims?: readonly ClaimType[];
  /** Expected holder. When set, tokens signed by any other wallet are rejected. */
  wallet?: string;
  /** Expected audience. When set, the signed `audience` must match exactly. */
  audience?: string;
  /** Clock skew tolerated when checking `issuedAt` / `expiresAt`. Defaults to 60. */
  clockSkewSeconds?: number;
  /** Require `expiresAt` in the payload. Defaults to `true`. */
  requireExpiry?: boolean;
  /**
   * Verify presented claims against ProofRegistry with `hasClaim` and enrich
   * failures with `checkClaimStatus`. Defaults to `true`; only disable it when
   * the token's signature alone is the intended check.
   */
  verifyClaims?: boolean;
  /**
   * Options forwarded to every on-chain read (`trustedIssuers`, `minThreshold`,
   * `source`, timeouts, ...). Chain reads are the default and the only safe
   * source for access-control decisions.
   */
  claimOptions?: ClaimOptions;
}

/** Machine-readable reasons a presentation token can fail verification. */
export type PresentationTokenFailureReason =
  | "malformed_token"
  | "unsupported_version"
  | "invalid_payload"
  | "invalid_wallet"
  | "invalid_signature"
  | "token_expired"
  | "token_not_yet_valid"
  | "expiry_required"
  | "audience_mismatch"
  | "wallet_mismatch"
  | "claim_missing"
  | "claim_not_verified"
  | "credential_expired"
  | "credential_revoked"
  | "on_chain_error"
  | "invalid_options";

/**
 * Result of {@link verifyPresentationToken}. This function never throws for
 * untrusted token content or remote verification failures; inspect `ok` and
 * `failureReason` instead.
 */
export interface PresentationTokenVerificationResult {
  /** True only when the token is well-formed, signed, fresh, and its claims verify. */
  ok: boolean;
  /** Holder wallet encoded in the token, or `""` when the token is malformed. */
  wallet: string;
  /** Claims presented by the token, or `[]` when the token is malformed. */
  claims: ClaimType[];
  /** Decoded payload when the envelope and payload were structurally valid. */
  payload?: PresentationTokenPayload;
  /** True only when the wallet signature over the signed payload verified. */
  signatureValid: boolean;
  /** True when on-chain claim verification ran. */
  claimsChecked: boolean;
  /** True when every presented claim verified on-chain. Absent when not checked. */
  claimsValid?: boolean;
  /** Per-claim on-chain status for claims that failed. Passing claims are omitted. */
  claimStatuses?: Partial<Record<ClaimType, CredentialStatusResult>>;
  /** First claim that failed verification, when applicable. */
  failedClaim?: ClaimType;
  /** Machine-readable failure reason; absent when `ok` is true. */
  failureReason?: PresentationTokenFailureReason;
  /** Human-readable explanation safe to log or show to the caller. */
  error?: string;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_VALUES = new Map<string, number>(
  Array.from(BASE64URL_ALPHABET).map((char, index) => [char, index]),
);

/**
 * Builds the exact message a holder must sign for a given encoded payload.
 * Exposed for custom wallet flows that do not use {@link createPresentationToken}.
 *
 * @param encodedPayload - The `base64url(payload JSON)` segment.
 */
export function presentationTokenSigningMessage(encodedPayload: string): string {
  return `${SIGNING_DOMAIN}\n${encodedPayload}`;
}

/**
 * Creates a compact, wallet-signed presentation token from claim types.
 *
 * Throws `TypeError` / `RangeError` for invalid *inputs* (bad wallet, empty or
 * unknown claims, impossible timestamps, malformed signature); verification
 * failures are reported by {@link verifyPresentationToken} instead.
 *
 * @example
 * ```ts
 * const token = await createPresentationToken({
 *   wallet: publicKey,
 *   claims: ["kyc", "age"],
 *   audience: "app.example.com",
 *   sign: async (message) => {
 *     const { signedMessage } = await freighter.signMessage(message);
 *     return signedMessage; // hex, base64, or Uint8Array
 *   },
 * });
 * ```
 */
export async function createPresentationToken(
  params: CreatePresentationTokenParams,
): Promise<string> {
  if (!isRecord(params)) {
    throw new TypeError("createPresentationToken requires a parameters object.");
  }
  if (typeof params.sign !== "function") {
    throw new TypeError("createPresentationToken requires a sign(message) function.");
  }

  const wallet = await normalizeWalletOrThrow(params.wallet);
  const claims = normalizeClaims(params.claims, "claims");

  const issuedAt = params.issuedAt ?? nowSeconds();
  assertUnixSeconds(issuedAt, "issuedAt");
  const expiresAt = params.expiresAt ?? issuedAt + DEFAULT_PRESENTATION_TOKEN_TTL_SECONDS;
  assertUnixSeconds(expiresAt, "expiresAt");
  if (expiresAt <= issuedAt) {
    throw new RangeError("expiresAt must be greater than issuedAt.");
  }

  const payload: PresentationTokenPayload = {
    v: PRESENTATION_TOKEN_VERSION,
    wallet,
    claims,
    issuedAt,
    expiresAt,
  };
  if (params.audience !== undefined) {
    payload.audience = assertNonEmptyString(params.audience, "audience");
  }
  const nonce =
    params.nonce === undefined ? randomNonce() : assertNonEmptyString(params.nonce, "nonce");
  if (nonce !== undefined) payload.nonce = nonce;

  const encodedPayload = utf8ToBase64Url(JSON.stringify(payload));
  const message = presentationTokenSigningMessage(encodedPayload);

  let signature: unknown;
  try {
    signature = await params.sign(message);
  } catch (error) {
    throw new TypeError(
      `createPresentationToken: sign(message) failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const signatureBytes = decodeSignatureInput(signature);
  if (signatureBytes.length !== SIGNATURE_BYTES) {
    throw new TypeError(
      `createPresentationToken: signature must be ${SIGNATURE_BYTES} bytes (received ${signatureBytes.length}).`,
    );
  }

  return `${PRESENTATION_TOKEN_PREFIX}.${encodedPayload}.${bytesToBase64Url(signatureBytes)}`;
}

/**
 * Verifies a presentation token server-side. Safe for Next.js App Router Server
 * Components and any Node.js or Edge handler: it never touches browser APIs and
 * returns a typed failure instead of throwing for bad tokens or failed remote
 * checks.
 *
 * @param token - The compact token string (`scpt1.<payload>.<signature>`), for
 *   example from a cookie, header, form field, or Server Action argument.
 * @param options - Expectations (required claims, wallet, audience, clock skew)
 *   and claim-verification settings.
 *
 * @example
 * ```ts
 * const result = await verifyPresentationToken(token, {
 *   requiredClaims: ["kyc"],
 *   audience: "app.example.com",
 *   claimOptions: { trustedIssuers: [PERSONA_ISSUER] },
 * });
 * if (!result.ok) {
 *   console.warn(result.failureReason, result.error);
 *   return new Response("Unauthorized", { status: 401 });
 * }
 * ```
 */
export async function verifyPresentationToken(
  token: string,
  options: VerifyPresentationTokenOptions = {},
): Promise<PresentationTokenVerificationResult> {
  const optionError = validateOptions(options);
  if (optionError) {
    return failure("invalid_options", optionError);
  }

  if (typeof token !== "string" || token.trim().length === 0) {
    return failure("malformed_token", "Presentation token must be a non-empty string.");
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return failure(
      "malformed_token",
      `Presentation token exceeds the ${MAX_TOKEN_LENGTH}-character limit.`,
    );
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return failure(
      "malformed_token",
      "Presentation token must contain exactly three dot-separated segments.",
    );
  }
  const [prefix, encodedPayload, encodedSignature] = parts as [string, string, string];
  if (prefix !== PRESENTATION_TOKEN_PREFIX) {
    return failure(
      "malformed_token",
      `Unsupported presentation token prefix "${prefix}". Expected "${PRESENTATION_TOKEN_PREFIX}".`,
    );
  }
  if (!encodedPayload || !encodedSignature) {
    return failure("malformed_token", "Presentation token has an empty payload or signature.");
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(utf8FromBase64Url(encodedPayload));
  } catch {
    return failure("malformed_token", "Presentation token payload is not valid base64url JSON.");
  }

  if (!isRecord(rawPayload)) {
    return failure("invalid_payload", "Presentation token payload must be a JSON object.");
  }

  if (!Number.isInteger(rawPayload.v)) {
    return failure("invalid_payload", "Presentation token payload is missing a numeric version.");
  }
  if (rawPayload.v !== PRESENTATION_TOKEN_VERSION) {
    return failure(
      "unsupported_version",
      `Unsupported presentation token version ${String(rawPayload.v)}. This SDK supports version ${PRESENTATION_TOKEN_VERSION}.`,
    );
  }

  const payload = rawPayload as unknown as PresentationTokenPayload;

  if (typeof payload.wallet !== "string" || payload.wallet.length === 0) {
    return failure("invalid_wallet", "Presentation token payload is missing a wallet.");
  }
  let wallet: string;
  try {
    wallet = await normalizeAndValidateWallet(payload.wallet);
  } catch {
    return failure(
      "invalid_wallet",
      "Presentation token payload contains an invalid Stellar wallet.",
    );
  }
  if (wallet !== payload.wallet) {
    return failure(
      "invalid_wallet",
      "Presentation token wallet must be a canonical Stellar address with no surrounding whitespace.",
    );
  }

  let claims: ClaimType[];
  try {
    claims = normalizeClaims(payload.claims, "payload.claims");
  } catch (error) {
    return failure("invalid_payload", messageOf(error));
  }

  if (!Number.isInteger(payload.issuedAt) || payload.issuedAt <= 0) {
    return failure(
      "invalid_payload",
      "Presentation token payload issuedAt must be a positive integer.",
    );
  }
  if (payload.expiresAt !== undefined) {
    if (!Number.isInteger(payload.expiresAt) || payload.expiresAt <= 0) {
      return failure(
        "invalid_payload",
        "Presentation token payload expiresAt must be a positive integer when present.",
      );
    }
    if (payload.expiresAt <= payload.issuedAt) {
      return failure(
        "invalid_payload",
        "Presentation token payload expiresAt must be after issuedAt.",
      );
    }
  } else if (options.requireExpiry !== false) {
    return failure(
      "expiry_required",
      "Presentation token has no expiresAt; set requireExpiry: false to accept non-expiring tokens.",
    );
  }

  if (payload.audience !== undefined && !isNonEmptyString(payload.audience)) {
    return failure(
      "invalid_payload",
      "Presentation token payload audience must be a non-empty string.",
    );
  }
  if (payload.nonce !== undefined && !isNonEmptyString(payload.nonce)) {
    return failure(
      "invalid_payload",
      "Presentation token payload nonce must be a non-empty string.",
    );
  }

  const signatureBytes = decodeSignatureSegment(encodedSignature);
  if (!signatureBytes) {
    return failure("malformed_token", "Presentation token signature is not valid base64url.");
  }
  if (signatureBytes.length !== SIGNATURE_BYTES) {
    return failure(
      "invalid_signature",
      `Presentation token signature must be ${SIGNATURE_BYTES} bytes (received ${signatureBytes.length}).`,
    );
  }

  const message = presentationTokenSigningMessage(encodedPayload);
  const signatureValid = verifyWalletSignature(wallet, message, signatureBytes);
  const base = {
    wallet,
    claims,
    payload,
    signatureValid,
  };

  if (!signatureValid) {
    return failure(
      "invalid_signature",
      "Presentation token signature is invalid for the presented wallet.",
      base,
    );
  }

  const now = nowSeconds();
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (payload.issuedAt > now + skew) {
    return failure("token_not_yet_valid", "Presentation token was issued in the future.", base);
  }
  if (payload.expiresAt !== undefined && now - skew >= payload.expiresAt) {
    return failure("token_expired", "Presentation token has expired.", base);
  }

  if (options.audience !== undefined && payload.audience !== options.audience) {
    return failure(
      "audience_mismatch",
      `Presentation token audience does not match "${options.audience}".`,
      base,
    );
  }

  if (options.wallet !== undefined) {
    let expectedWallet: string;
    try {
      expectedWallet = await normalizeAndValidateWallet(options.wallet);
    } catch {
      return failure(
        "invalid_options",
        "verifyPresentationToken: options.wallet is not a valid Stellar address.",
        base,
      );
    }
    if (expectedWallet !== wallet) {
      return failure(
        "wallet_mismatch",
        "Presentation token was signed by a different wallet.",
        base,
      );
    }
  }

  const requiredClaims = options.requiredClaims ?? [];
  for (const required of requiredClaims) {
    if (!claims.includes(required)) {
      return failure(
        "claim_missing",
        `Presentation token does not present the required "${required}" claim.`,
        base,
        { failedClaim: required },
      );
    }
  }

  if (options.verifyClaims === false) {
    return {
      ok: true,
      ...base,
      claimsChecked: false,
    };
  }

  const claimResults = await verifyClaimsOnChain(wallet, claims, options.claimOptions);
  if (claimResults.failureReason === "on_chain_error") {
    return failure(
      "on_chain_error",
      claimResults.error ?? "On-chain claim verification failed.",
      base,
    );
  }
  if (!claimResults.valid) {
    return failure(
      claimResults.failureReason ?? "claim_not_verified",
      claimResults.error ?? "Presentation token claim is not valid on-chain.",
      base,
      {
        claimsChecked: true,
        claimsValid: false,
        ...(claimResults.statuses ? { claimStatuses: claimResults.statuses } : {}),
        ...(claimResults.failedClaim ? { failedClaim: claimResults.failedClaim } : {}),
      },
    );
  }

  return {
    ok: true,
    ...base,
    claimsChecked: true,
    claimsValid: true,
  };
}

// ---------------------------------------------------------------------------
// Claim verification
// ---------------------------------------------------------------------------

interface ClaimVerificationOutcome {
  valid: boolean;
  failureReason?: PresentationTokenFailureReason;
  error?: string;
  failedClaim?: ClaimType;
  statuses?: Partial<Record<ClaimType, CredentialStatusResult>>;
}

async function verifyClaimsOnChain(
  wallet: string,
  claims: readonly ClaimType[],
  claimOptions: ClaimOptions | undefined,
): Promise<ClaimVerificationOutcome> {
  let results: { claim: ClaimType; valid: boolean }[];
  try {
    results = await Promise.all(
      claims.map(async (claim) => ({
        claim,
        valid: await hasClaim(wallet, claim, claimOptions),
      })),
    );
  } catch (error) {
    return {
      valid: false,
      failureReason: "on_chain_error",
      error: `On-chain claim verification failed: ${messageOf(error)}`,
    };
  }

  const failed = results.find((result) => !result.valid);
  if (!failed) return { valid: true };

  const statuses: Partial<Record<ClaimType, CredentialStatusResult>> = {};
  let status: CredentialStatusResult | undefined;
  try {
    status = await checkClaimStatus(wallet, failed.claim, claimOptions);
    statuses[failed.claim] = status;
  } catch {
    // hasClaim already established the claim is not usable; status is best-effort detail.
  }

  let failureReason: PresentationTokenFailureReason = "claim_not_verified";
  if (status?.status === "expired") failureReason = "credential_expired";
  else if (status?.status === "revoked") failureReason = "credential_revoked";

  const detail = status?.error ? ` ${status.error}` : "";
  return {
    valid: false,
    failureReason,
    error: `Presentation token claim "${failed.claim}" is not valid on-chain.${detail}`,
    failedClaim: failed.claim,
    statuses,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function failure(
  reason: PresentationTokenFailureReason,
  error: string,
  base: Partial<PresentationTokenVerificationResult> = {},
  extra: Partial<PresentationTokenVerificationResult> = {},
): PresentationTokenVerificationResult {
  return {
    ok: false,
    wallet: "",
    claims: [],
    signatureValid: false,
    claimsChecked: false,
    failureReason: reason,
    error,
    ...base,
    ...extra,
  };
}

function validateOptions(options: VerifyPresentationTokenOptions): string | null {
  if (!isRecord(options)) {
    return "verifyPresentationToken options must be an object.";
  }
  const skew = (options as { clockSkewSeconds?: unknown }).clockSkewSeconds;
  if (skew !== undefined) {
    if (typeof skew !== "number" || !Number.isInteger(skew) || skew < 0) {
      return "clockSkewSeconds must be a non-negative integer (seconds).";
    }
  }
  if (options.requiredClaims !== undefined) {
    if (!Array.isArray(options.requiredClaims)) {
      return "requiredClaims must be an array of claim types.";
    }
    for (const claim of options.requiredClaims) {
      if (typeof claim !== "string" || !isValidClaimType(claim)) {
        return `requiredClaims contains an unknown claim type: ${String(claim)}.`;
      }
    }
  }
  if (options.audience !== undefined && !isNonEmptyString(options.audience)) {
    return "audience must be a non-empty string when provided.";
  }
  if (options.wallet !== undefined && !isNonEmptyString(options.wallet)) {
    return "wallet must be a non-empty string when provided.";
  }
  if (options.claimOptions !== undefined && !isRecord(options.claimOptions)) {
    return "claimOptions must be an object when provided.";
  }
  return null;
}

async function normalizeWalletOrThrow(wallet: unknown): Promise<string> {
  if (typeof wallet !== "string" || wallet.trim().length === 0) {
    throw new TypeError("wallet must be a non-empty Stellar public key.");
  }
  try {
    const normalized = await normalizeAndValidateWallet(wallet);
    if (normalized !== wallet) {
      throw new TypeError("wallet must be a canonical Stellar address.");
    }
    return normalized;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`wallet is not a valid Stellar address: ${messageOf(error)}`);
  }
}

function normalizeClaims(claims: unknown, field: string): ClaimType[] {
  if (!Array.isArray(claims) || claims.length === 0) {
    throw new TypeError(`${field} must be a non-empty array of claim types.`);
  }
  if (claims.length > MAX_PRESENTED_CLAIMS) {
    throw new RangeError(`${field} cannot contain more than ${MAX_PRESENTED_CLAIMS} claims.`);
  }
  const normalized: ClaimType[] = [];
  for (const claim of claims) {
    if (typeof claim !== "string" || !isValidClaimType(claim)) {
      throw new TypeError(`${field} contains an unknown claim type: ${String(claim)}.`);
    }
    if (normalized.includes(claim)) {
      throw new TypeError(`${field} contains a duplicate claim type: "${claim}".`);
    }
    normalized.push(claim);
  }
  return normalized;
}

function assertUnixSeconds(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${field} must be a positive integer Unix timestamp in seconds.`);
  }
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomNonce(): string | undefined {
  const cryptoImpl = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") {
    return cryptoImpl.randomUUID().replace(/-/g, "");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Signatures and encoding
// ---------------------------------------------------------------------------

function decodeSignatureInput(signature: unknown): Uint8Array {
  if (signature instanceof Uint8Array) return signature;
  if (typeof signature !== "string") {
    throw new TypeError(
      "sign(message) must return a hex, base64, base64url, or Uint8Array signature.",
    );
  }
  const clean = signature.trim();
  if (/^[0-9a-fA-F]{128}$/.test(clean)) return hexToBytes(clean);

  const normalized = clean.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    return base64UrlToBytes(normalized);
  } catch {
    throw new TypeError(
      "sign(message) returned a signature that is not valid hex, base64, or base64url.",
    );
  }
}

function decodeSignatureSegment(segment: string): Uint8Array | null {
  try {
    return base64UrlToBytes(segment);
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] as number;
    const second = index + 1 < bytes.length ? (bytes[index + 1] as number) : 0;
    const third = index + 2 < bytes.length ? (bytes[index + 2] as number) : 0;

    output += BASE64URL_ALPHABET[first >> 2];
    output += BASE64URL_ALPHABET[((first & 0b11) << 4) | (second >> 4)];
    if (index + 1 < bytes.length) {
      output += BASE64URL_ALPHABET[((second & 0b1111) << 2) | (third >> 6)];
    }
    if (index + 2 < bytes.length) {
      output += BASE64URL_ALPHABET[third & 0b111111];
    }
  }
  return output;
}

function base64UrlToBytes(value: string): Uint8Array {
  if (value.length === 0) throw new TypeError("Empty base64url value.");
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("Invalid base64url characters.");
  }
  if (value.length % 4 === 1) throw new TypeError("Invalid base64url length.");

  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (const char of value) {
    const digit = BASE64URL_VALUES.get(char);
    if (digit === undefined) throw new TypeError("Invalid base64url character.");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }

  return bytes.subarray(0, index);
}

function utf8ToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function utf8FromBase64Url(value: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(value));
}
