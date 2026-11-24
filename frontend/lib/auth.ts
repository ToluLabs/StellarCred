/**
 * Shared authentication helpers for API routes.
 *
 * Every credential the API accepts is parsed and checked here, so routes (via
 * `app/api/_middleware.ts`) never re-implement header parsing or secret
 * comparison:
 *
 *   token    extractBearerToken(), isTokenExpired()
 *   API key  extractApiKey(), verifyApiKey(), checkAdminAuth()
 *   session  authFailure() / AuthResult - the uniform outcome of resolving
 *            who the caller is
 *
 * Admin routes are protected by a shared secret delivered as
 * `Authorization: Bearer <ADMIN_API_KEY>`. If ADMIN_API_KEY is not set every
 * admin request is denied, so new deployments are not accidentally exposed.
 *
 * This module is dependency-free (no tenancy/store imports) so lower-level
 * modules such as `lib/tenancy.ts` can use it without an import cycle.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

/** Standard 401 response body. */
export const UNAUTHORIZED = { error: "Unauthorized" } as const;

/** Outcome of authenticating a caller: the resolved identity, or a rejection. */
export type AuthResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** Build a rejected {@link AuthResult}. */
export function authFailure(
  status: number,
  error: string,
): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

/** Header lookup that works for both `Headers` and plain header records. */
export type HeaderSource = Headers | Record<string, string | null | undefined>;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if ("get" in headers && typeof headers.get === "function") {
    return headers.get(name)?.trim() || undefined;
  }
  const rec = headers as Record<string, string | null | undefined>;
  const direct = rec[name] || rec[name.toLowerCase()];
  return direct ? String(direct).trim() || undefined : undefined;
}

// ── Token ────────────────────────────────────────────────────────────────────

/**
 * Return the token from an `Authorization: Bearer <token>` header value, or
 * undefined when the header is absent, uses another scheme, or has no token.
 * The scheme is matched case-insensitively.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1].trim() || undefined;
}

/**
 * True when a token's `expiresAt` (epoch ms) is in the past. A token is still
 * valid at exactly its expiry instant. Non-finite values count as expired.
 */
export function isTokenExpired(expiresAt: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(expiresAt)) return true;
  return now > expiresAt;
}

// ── API key ──────────────────────────────────────────────────────────────────

/**
 * Return the caller's API key: the `x-api-key` header, falling back to an
 * `Authorization: Bearer` token.
 */
export function extractApiKey(headers: HeaderSource): string | undefined {
  return (
    readHeader(headers, "x-api-key") ?? extractBearerToken(readHeader(headers, "authorization"))
  );
}

/**
 * Compare a provided key against the configured one in constant time (for
 * equal lengths) to avoid timing oracles. An unset or blank configured key
 * never matches.
 */
export function verifyApiKey(
  provided: string | null | undefined,
  configured: string | null | undefined,
): boolean {
  if (!configured || !configured.trim()) return false;
  if (!provided) return false;
  if (provided.length !== configured.length) return false;

  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ configured.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Returns true when the incoming request carries a valid admin API key in
 * `Authorization: Bearer <ADMIN_API_KEY>`.
 */
export function checkAdminAuth(req: Pick<NextRequest, "headers">): boolean {
  const token = extractBearerToken(req.headers.get("authorization"));
  return verifyApiKey(token, process.env.ADMIN_API_KEY);
}

// ── Session token validation (#945) ──────────────────────────────────────────

export interface SessionPayload {
  sub: string;
  exp: number;
  iat: number;
  iss?: string;
  nonce?: string;
  role?: string;
  [key: string]: unknown;
}

export interface SessionValidationOptions {
  secret?: string;
  now?: number;
  maxSkewSeconds?: number;
  allowedIssuers?: string[];
  usedNonces?: Set<string>;
}

/**
 * Creates a signed session token for testing and authentication.
 */
export function createSignedSessionToken(
  payload: Omit<SessionPayload, "iat"> & { iat?: number },
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload: SessionPayload = {
    ...payload,
    iat: payload.iat ?? now,
  };
  const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(fullPayload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Hardened validation for API sessions and authentication tokens.
 * Rejects unsigned, expired, forged, or replayed tokens.
 */
export function validateSessionToken(
  token: string | null | undefined,
  options: SessionValidationOptions = {},
): AuthResult<SessionPayload> {
  if (!token || typeof token !== "string" || token.trim() === "") {
    return authFailure(401, "missing session token");
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return authFailure(401, "malformed session token");
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return authFailure(401, "incomplete session token");
  }

  // Parse and validate header
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch {
    return authFailure(401, "invalid token header");
  }

  if (!header.alg || header.alg.toLowerCase() === "none" || header.alg !== "HS256") {
    return authFailure(401, "unsupported or unsigned algorithm");
  }

  // Verify HMAC signature
  const secret = options.secret ?? process.env.SESSION_SECRET;
  if (!secret) {
    return authFailure(500, "session secret unconfigured");
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  const sigBuf = Buffer.from(signatureB64);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return authFailure(401, "invalid signature");
  }

  // Parse and validate payload
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return authFailure(401, "invalid token payload");
  }

  if (!payload || typeof payload !== "object") {
    return authFailure(401, "invalid token payload");
  }

  if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
    return authFailure(401, "missing subject in token");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maxSkew = options.maxSkewSeconds ?? 60;

  // Expiry check (exp is in epoch seconds)
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return authFailure(401, "missing or invalid expiration");
  }
  if (now > payload.exp) {
    return authFailure(401, "session expired");
  }

  // Issued-at sanity check
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
    return authFailure(401, "missing or invalid issued-at");
  }
  if (payload.iat > now + maxSkew) {
    return authFailure(401, "token issued in future");
  }

  // Issuer verification
  if (options.allowedIssuers && options.allowedIssuers.length > 0) {
    if (!payload.iss || !options.allowedIssuers.includes(payload.iss)) {
      return authFailure(403, "untrusted session issuer");
    }
  }

  // Replay prevention via nonce
  if (payload.nonce) {
    if (options.usedNonces) {
      if (options.usedNonces.has(payload.nonce)) {
        return authFailure(401, "replayed session token");
      }
      options.usedNonces.add(payload.nonce);
    }
  }

  return { ok: true, value: payload };
}
