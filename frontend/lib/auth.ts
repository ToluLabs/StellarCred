/**
 * Shared authentication helpers for API routes.
 *
 * Every credential the API accepts is parsed and checked here, so routes (via
 * `app/api/_middleware.ts`) never re-implement header parsing or secret
 * comparison:
 *
 *   token    extractBearerToken(), isTokenExpired()
 *   API key  extractApiKey(), verifyApiKey(), checkAdminAuth()
 *   session  authFailure() / AuthResult — the uniform outcome of resolving
 *            who the caller is
 *
 * Admin routes are protected by a shared secret delivered as
 * `Authorization: Bearer <ADMIN_API_KEY>`. If ADMIN_API_KEY is not set every
 * admin request is denied, so new deployments are not accidentally exposed.
 *
 * This module is dependency-free (no tenancy/store imports) so lower-level
 * modules such as `lib/tenancy.ts` can use it without an import cycle.
 */

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
