/**
 * Admin API authentication helper (#783).
 *
 * All admin routes are protected by a shared secret delivered as:
 *   Authorization: Bearer <ADMIN_API_KEY>
 *
 * Set ADMIN_API_KEY in your .env.local (or production secrets). If the env var
 * is not set the guard returns false for every request, so the routes are
 * inaccessible until the key is configured — this prevents accidental exposure
 * in new deployments.
 */

import type { NextRequest } from "next/server";

/**
 * Returns true when the incoming request carries a valid admin API key.
 *
 * Checks the `Authorization: Bearer <token>` header against the
 * `ADMIN_API_KEY` environment variable using a constant-time comparison to
 * avoid timing-oracle attacks.
 */
export function checkAdminAuth(req: NextRequest): boolean {
  const configuredKey = process.env.ADMIN_API_KEY;
  // If no key is configured, deny all requests.
  if (!configuredKey || !configuredKey.trim()) return false;

  const authHeader = req.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const provided = match[1];

  // Constant-time comparison to prevent timing oracle attacks.
  // Both strings are encoded to equal-length buffers; mismatched lengths produce false.
  if (provided.length !== configuredKey.length) return false;

  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ configuredKey.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Standard 401 response body. */
export const UNAUTHORIZED = { error: "Unauthorized" } as const;
