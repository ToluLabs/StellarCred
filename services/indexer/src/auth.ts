/**
 * auth.ts — Optional API-key / bearer-token authentication middleware.
 *
 * Design
 * ──────
 * Authentication is OFF by default. Setting the `API_KEY` environment variable
 * switches the indexer into authenticated mode. In that mode every request to
 * a guarded endpoint must present the key as one of:
 *
 *   Authorization: Bearer <key>
 *   X-API-Key: <key>
 *
 * When `API_KEY` is absent or empty the middleware is a no-op and every
 * endpoint behaves exactly as before, so public deployments require no
 * configuration changes.
 *
 * Per-endpoint policy
 * ───────────────────
 * Use `requireAuth(apiKey)` as per-route middleware on endpoints that should
 * be gated, and omit it on endpoints that should stay public regardless of
 * mode (e.g. /health for readiness probes).
 *
 *   app.get("/health",  healthHandler);          // always public
 *   app.get("/claims",  requireAuth(key), ...);  // gated when key is set
 *
 * `requireAuth(undefined)` returns a pass-through middleware, so callers
 * don't need a conditional — just pass `config.apiKey` and the middleware
 * self-configures.
 *
 * Token comparison
 * ────────────────
 * Keys are compared with `timingSafeEqual` to prevent timing-oracle attacks.
 * The function works on Buffer/Uint8Array; both sides are encoded as UTF-8
 * before comparison.  If the lengths differ a constant-time dummy comparison
 * is still performed to avoid leaking length information via response time.
 */

import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Extract the raw token string from the request.
 * Accepts:
 *   Authorization: Bearer <token>   (canonical OAuth2 bearer header)
 *   X-API-Key: <token>              (simpler alternative for non-browser clients)
 *
 * Returns undefined if neither header is present or the Authorization header
 * uses a scheme other than Bearer.
 */
function extractToken(req: Request): string | undefined {
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
      return parts[1];
    }
    // Malformed Authorization header — don't fall through to X-API-Key
    return undefined;
  }
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
    return apiKeyHeader;
  }
  return undefined;
}

/**
 * Constant-time string comparison to mitigate timing attacks.
 *
 * Node's `timingSafeEqual` requires both Buffers to have the same byte
 * length. When they differ we still run the comparison against a dummy
 * buffer of the expected length so the response time is independent of
 * how many bytes the attacker guessed correctly.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Perform a dummy comparison to keep timing uniform, then return false.
    timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Returns an Express middleware that enforces API-key authentication when
 * `apiKey` is a non-empty string, or a pass-through no-op when `apiKey` is
 * undefined/empty.
 *
 * Usage:
 *   app.get("/claims", requireAuth(config.apiKey), handler);
 *
 * When enforcing:
 *   - Valid token  → calls next() and the route handler runs normally.
 *   - Missing token → 401 { error: "authentication required" }
 *   - Wrong token   → 401 { error: "invalid API key" }
 *     (same status code for both to avoid confirming whether a key exists)
 */
export function requireAuth(apiKey: string | undefined): RequestHandler {
  // Public mode: no-op middleware
  if (!apiKey) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  // Authenticated mode
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = extractToken(req);

    if (token === undefined) {
      res.status(401).json({ error: "authentication required" });
      return;
    }

    if (!safeEqual(token, apiKey)) {
      res.status(401).json({ error: "invalid API key" });
      return;
    }

    next();
  };
}
