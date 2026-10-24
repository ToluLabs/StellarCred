/**
 * Resumable-download cursor tokens (#784).
 *
 * The cursor the client passes is an opaque, HMAC-signed, self-contained token
 * encoding `{ jobId, index }`. It is tamper-resistant (a client cannot forge a
 * cursor for another job) and stateless (multiple clients can page
 * independently). A separate persisted `CursorHandle` in the shared store
 * records the last-served index for observability — see `export-job-store.ts`;
 * THIS signed token is what the client needs to resume.
 *
 * Token format:
 *   base64url(JSON.stringify({ j: jobId, i: index })) + "." + hmacSha256(secret, payload)
 *
 * The signature is over the ORIGINAL decoded payload bytes (not a
 * re-serialized copy), so key-order/whitespace cannot cause a false rejection.
 * `base64url` output never contains a `.`, so `split(".")` with exactly 2
 * parts is unambiguous.
 */

import { createHmac, timingSafeEqual } from "crypto";

export interface CursorPayload {
  j: string;
  i: number;
}

export type CursorVerifyResult =
  | { ok: true; jobId: string; index: number }
  | { ok: false; reason: string };

/**
 * Resolve the signing secret. Trim each candidate first, then fall back:
 * a whitespace-only `EXPORT_CURSOR_SECRET` trims to "" and falls through to
 * `ADMIN_API_KEY` rather than short-circuiting. Both unset → "" (signing
 * disabled). Since every admin route already requires a non-empty
 * `ADMIN_API_KEY`, the fallback covers dev/tests out of the box.
 */
function cursorSecret(): string {
  return (
    process.env.EXPORT_CURSOR_SECRET?.trim() ||
    process.env.ADMIN_API_KEY?.trim() ||
    ""
  );
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * Create a signed cursor token for `index`. Throws if no signing secret is
 * configured. In practice the route's `checkAdminAuth` gate already ensures a
 * non-empty `ADMIN_API_KEY`, so this does not throw in production.
 */
export function createCursor(jobId: string, index: number): string {
  const secret = cursorSecret();
  if (!secret) {
    throw new Error(
      "EXPORT_CURSOR_SECRET or ADMIN_API_KEY must be set to sign cursors",
    );
  }
  const payloadJson = JSON.stringify({ j: jobId, i: index });
  const sig = createHmac("sha256", secret).update(payloadJson).digest("hex");
  return base64UrlEncode(payloadJson) + "." + sig;
}

/**
 * Verify a cursor token. NEVER throws — any unexpected error returns
 * `{ ok: false, reason: "malformed cursor" }`. Length-checks the signature
 * before `timingSafeEqual` to avoid a `RangeError` on a truncated/long sig.
 */
export function verifyCursor(token: string): CursorVerifyResult {
  try {
    if (typeof token !== "string" || token.length === 0) {
      return { ok: false, reason: "malformed cursor" };
    }
    const firstDot = token.indexOf(".");
    if (firstDot < 0 || token.indexOf(".", firstDot + 1) !== -1) {
      return { ok: false, reason: "malformed cursor" };
    }
    const payloadB64 = token.slice(0, firstDot);
    const sigPart = token.slice(firstDot + 1);

    const secret = cursorSecret();
    if (!secret) {
      return { ok: false, reason: "cursor signing not configured" };
    }

    let payloadJson: string;
    try {
      payloadJson = base64UrlDecode(payloadB64);
    } catch {
      return { ok: false, reason: "malformed cursor" };
    }

    const expected = createHmac("sha256", secret)
      .update(payloadJson)
      .digest("hex");

    // Length check first so timingSafeEqual never throws on a length mismatch.
    if (sigPart.length !== expected.length) {
      return { ok: false, reason: "invalid cursor signature" };
    }
    let match = true;
    try {
      match = timingSafeEqual(Buffer.from(expected), Buffer.from(sigPart));
    } catch {
      return { ok: false, reason: "invalid cursor signature" };
    }
    if (!match) {
      return { ok: false, reason: "invalid cursor signature" };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(payloadJson);
    } catch {
      return { ok: false, reason: "malformed cursor" };
    }
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw)
    ) {
      return { ok: false, reason: "malformed cursor" };
    }
    const obj = raw as { j?: unknown; i?: unknown };
    if (typeof obj.j !== "string" || obj.j.length === 0) {
      return { ok: false, reason: "malformed cursor" };
    }
    if (typeof obj.i !== "number" || !Number.isInteger(obj.i) || obj.i < 0) {
      return { ok: false, reason: "malformed cursor" };
    }
    return { ok: true, jobId: obj.j, index: obj.i };
  } catch {
    return { ok: false, reason: "malformed cursor" };
  }
}
