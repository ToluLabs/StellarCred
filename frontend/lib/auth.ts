// frontend/lib/auth.ts
//
// Single source of truth for request authentication.
//
// Every API route used to grow its own credential check: re-parsing an
// `Authorization: Bearer` header, re-reading `x-api-key`, re-verifying an
// HMAC signature, or re-decoding a session cookie. Those copies drifted —
// different error codes, different expiry handling, different comparison
// semantics — which is exactly the class of bug that turns into a security
// hole (one route forgets to check expiry, another compares keys with `===`).
//
// This module owns all of it:
//
//   - token   — HMAC-signed, self-describing tokens (bearer tokens, secure
//               download links)
//   - apiKey  — opaque shared secrets, compared in constant time
//   - session — cookie-carried signed session values
//
// Routes call these helpers; app/api/_middleware.ts turns the results into
// HTTP responses so every route rejects a bad credential the same way.
//
// Deliberately dependency-free (only `crypto`): this module is reachable
// from the browser bundle through lib/export-jobs.ts ->
// lib/security/secureDownload.ts, so pulling pino/zod/next-server in here
// would bloat or break the client build.

import crypto from "crypto";

export type AuthMethod = "token" | "apiKey" | "session";

export type AuthErrorCode =
  | "missing_credentials"
  | "invalid_api_key"
  | "invalid_token"
  | "token_expired"
  | "invalid_session"
  | "session_expired";

export interface AuthError {
  code: AuthErrorCode;
  message: string;
  status: number;
}

export type AuthResult<T> = { ok: true; value: T } | { ok: false; error: AuthError };

/**
 * Anything we can read headers out of: a `Headers` instance, a plain record of
 * headers, or a request-like object exposing `.headers`.
 */
export type HeaderSource =
  Headers | Record<string, string | null | undefined> | { headers: Headers };

function isHeadersLike(value: unknown): value is Headers {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

function toHeaderBag(source: HeaderSource): Headers | Record<string, string | null | undefined> {
  if (isHeadersLike(source)) return source;
  if ("headers" in source && isHeadersLike((source as { headers: unknown }).headers)) {
    return (source as { headers: Headers }).headers;
  }
  return source as Record<string, string | null | undefined>;
}

/**
 * Reads a single header, trimmed. Returns `undefined` for missing and empty
 * values so callers can rely on a plain truthiness check.
 */
export function getHeader(source: HeaderSource, name: string): string | undefined {
  const bag = toHeaderBag(source);
  if (isHeadersLike(bag)) {
    const value = bag.get(name);
    return value?.trim() || undefined;
  }
  const record = bag as Record<string, string | null | undefined>;
  const direct = record[name] || record[name.toLowerCase()];
  return direct ? String(direct).trim() : undefined;
}

/**
 * Returns the first header present out of `names`, in order. Used for
 * endpoints that accept a signature under several historical header names.
 */
export function firstHeader(source: HeaderSource, names: string[]): string | undefined {
  for (const name of names) {
    const value = getHeader(source, name);
    if (value) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bearer tokens
// ---------------------------------------------------------------------------

/**
 * Extracts the credential from an `Authorization: Bearer <credential>` header.
 * Returns `undefined` for a missing header or any other auth scheme.
 */
export function parseBearerToken(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return undefined;
  const token = match[1].trim();
  return token || undefined;
}

/**
 * Extracts the bearer credential from a request's Authorization header.
 */
export function extractBearerToken(source: HeaderSource): string | undefined {
  return parseBearerToken(getHeader(source, "authorization"));
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/**
 * Extracts an API key from `x-api-key`, falling back to the bearer credential
 * of the Authorization header. An explicit `x-api-key` always wins.
 */
export function extractApiKey(source: HeaderSource): string | undefined {
  const explicit = getHeader(source, "x-api-key");
  if (explicit) return explicit;
  return extractBearerToken(source);
}

/**
 * Constant-time string comparison.
 *
 * Both sides are hashed first so that unequal lengths do not short-circuit:
 * the comparison itself is constant time regardless of input length, and the
 * digest length never leaks the length of the secret.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Verifies a presented API key against one or more accepted keys.
 *
 * Every candidate is compared (never short-circuits on the first match) so
 * the number of comparisons does not reveal how many keys are configured.
 */
export function verifyApiKey(
  provided: string | null | undefined,
  expected: string | string[] | null | undefined,
): boolean {
  if (!provided || !expected) return false;
  const candidates = Array.isArray(expected) ? expected : [expected];
  let matched = false;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (timingSafeEqualString(provided, candidate)) matched = true;
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Signed tokens
// ---------------------------------------------------------------------------

export interface TokenPayload {
  /** Expiry as seconds since the epoch. */
  exp?: number;
  /** Expiry as milliseconds since the epoch. */
  expiresAt?: number;
  /** Issued-at as seconds since the epoch. */
  iat?: number;
  /** Subject identifier (user, tenant, key id). */
  sub?: string;
  [key: string]: unknown;
}

export interface TokenVerification<T extends TokenPayload = TokenPayload> {
  isValid: boolean;
  payload?: T;
  error?: string;
  code?: AuthErrorCode;
}

/**
 * Signs a payload into a `base64url(payload).base64url(hmac)` token.
 *
 * The payload is embedded verbatim — no field is added or rewritten — so
 * callers stay in control of the token's wire format.
 */
export function signToken(payload: TokenPayload, secret: string): string {
  if (!secret) throw new Error("signToken requires a non-empty secret");
  const payloadString = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadString).digest("base64url");
  return `${payloadString}.${signature}`;
}

/**
 * Verifies a signed token: structure, HMAC signature, then expiry.
 *
 * Expiry is read from `exp` (seconds) or `expiresAt` (milliseconds); a token
 * carrying neither never expires.
 */
export function verifyToken<T extends TokenPayload = TokenPayload>(
  token: string | null | undefined,
  secret: string,
  options: { now?: number } = {},
): TokenVerification<T> {
  if (!token || typeof token !== "string") {
    return { isValid: false, error: "Missing token", code: "invalid_token" };
  }
  if (!secret) {
    return { isValid: false, error: "Missing token", code: "invalid_token" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return { isValid: false, error: "Invalid token structure", code: "invalid_token" };
  }

  const [payloadString, signature] = parts;

  let expectedSignature: string;
  try {
    expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payloadString)
      .digest("base64url");
  } catch {
    return { isValid: false, error: "Invalid token signature", code: "invalid_token" };
  }

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { isValid: false, error: "Invalid token signature", code: "invalid_token" };
  }

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(payloadString, "base64url").toString("utf8")) as T;
  } catch (err) {
    return {
      isValid: false,
      error: err instanceof Error ? err.message : "Verification failed",
      code: "invalid_token",
    };
  }

  const now = options.now ?? Date.now();
  const expirySeconds = typeof payload.exp === "number" ? payload.exp : undefined;
  const expiryMs = typeof payload.expiresAt === "number" ? payload.expiresAt : undefined;
  const expiresAtMs =
    expirySeconds !== undefined
      ? expirySeconds * 1000
      : expiryMs !== undefined
        ? expiryMs
        : undefined;

  if (expiresAtMs !== undefined && now > expiresAtMs) {
    return { isValid: false, payload, error: "Token has expired", code: "token_expired" };
  }

  return { isValid: true, payload };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_COOKIE_NAME = "sc_session";

export interface SessionPayload extends TokenPayload {
  sub?: string;
  role?: "admin" | "user";
  scopes?: string[];
}

/**
 * Parses a `Cookie` header into a plain record.
 */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

/**
 * Reads a single cookie value from a request.
 */
export function getCookie(source: HeaderSource, name: string): string | undefined {
  const raw = getHeader(source, "cookie");
  if (!raw) return undefined;
  return parseCookies(raw)[name] || undefined;
}

export interface SignedSession {
  token: string;
  expiresAt: number;
}

/**
 * Creates a signed session token carrying an `exp` claim.
 */
export function createSessionToken(
  payload: Omit<SessionPayload, "exp" | "iat">,
  secret: string,
  ttlSeconds: number,
  options: { now?: number } = {},
): SignedSession {
  if (!secret) throw new Error("createSessionToken requires a non-empty secret");
  const now = options.now ?? Date.now();
  const iat = Math.floor(now / 1000);
  const exp = iat + Math.max(0, Math.floor(ttlSeconds));
  const token = signToken({ ...payload, iat, exp }, secret);
  return { token, expiresAt: exp * 1000 };
}

export interface SessionVerification {
  isValid: boolean;
  session?: SessionPayload;
  error?: string;
  code?: AuthErrorCode;
}

/**
 * Verifies a signed session token, rejecting expired sessions.
 */
export function verifySessionToken(
  token: string | null | undefined,
  secret: string,
  options: { now?: number } = {},
): SessionVerification {
  const result = verifyToken<SessionPayload>(token, secret, options);
  if (!result.isValid) {
    const code: AuthErrorCode =
      result.code === "token_expired" ? "session_expired" : "invalid_session";
    return { isValid: false, error: result.error, code };
  }
  return { isValid: true, session: result.payload };
}

// ---------------------------------------------------------------------------
// HMAC request signatures
// ---------------------------------------------------------------------------

export interface HmacSignatureOptions {
  /** Max clock skew, in seconds, for the `t=<ts>,v1=<hex>` format. */
  toleranceSeconds?: number;
}

/**
 * Verifies an HMAC-SHA256 signature over a raw request body.
 *
 * Supports the two formats providers send in practice:
 *   - `t=<ts>,v1=<hex>` — timestamped, with a bounded skew window
 *   - `<hex>` / `sha256=<hex>` — plain
 */
export function verifyHmacSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
  options: HmacSignatureOptions = {},
): boolean {
  if (!signatureHeader || !secret || typeof rawBody !== "string") return false;

  try {
    let expectedSigHex: string;
    let actualSigHex: string;

    if (signatureHeader.includes("t=") && signatureHeader.includes("v1=")) {
      const parts = signatureHeader.split(",").reduce<Record<string, string>>((acc, item) => {
        const [k, v] = item.trim().split("=");
        if (k && v) acc[k] = v;
        return acc;
      }, {});

      const timestamp = parts.t;
      actualSigHex = parts.v1;
      if (!timestamp || !actualSigHex) return false;

      const now = Math.floor(Date.now() / 1000);
      const parsedTime = parseInt(timestamp, 10);
      if (isNaN(parsedTime) || Math.abs(now - parsedTime) > (options.toleranceSeconds ?? 300)) {
        return false;
      }

      expectedSigHex = crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
    } else {
      actualSigHex = signatureHeader.startsWith("sha256=")
        ? signatureHeader.slice(7)
        : signatureHeader;

      expectedSigHex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    }

    if (actualSigHex.length !== expectedSigHex.length) return false;

    const actualBuffer = Buffer.from(actualSigHex, "hex");
    const expectedBuffer = Buffer.from(expectedSigHex, "hex");

    if (actualBuffer.length !== expectedBuffer.length) return false;

    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request-level authentication
// ---------------------------------------------------------------------------

/**
 * The authenticated caller, however the credential was presented.
 */
export interface AuthPrincipal {
  method: AuthMethod;
  /** Stable identifier for the caller: key id, session subject, token subject. */
  subject: string;
  role: "admin" | "user";
  scopes: string[];
  /** Decoded token/session payload, when the credential carried one. */
  payload?: Record<string, unknown>;
}

export interface AuthenticateOptions {
  /** Credential kinds this route accepts. Defaults to all of them. */
  methods?: AuthMethod[];
  /** Accepted API keys. */
  apiKeys?: string | string[];
  /** Secret used to verify bearer tokens. */
  tokenSecret?: string;
  /** Secret used to verify session cookies. */
  sessionSecret?: string;
  /** Session cookie name. Defaults to SESSION_COOKIE_NAME. */
  sessionCookieName?: string;
}

function scopesFromPayload(payload: Record<string, unknown> | undefined): string[] {
  const scopes = payload?.scopes;
  return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [];
}

function roleFromPayload(payload: Record<string, unknown> | undefined): "admin" | "user" {
  return payload?.role === "admin" ? "admin" : "user";
}

/**
 * Authenticates a request against the configured credential kinds.
 *
 * The first method that yields a *valid* credential wins. A method that is
 * present but invalid (bad key, expired token) fails the request outright
 * rather than falling through to the next method — a caller must never be
 * able to downgrade a rejected credential into an accepted weaker one.
 */
export function authenticateRequest(
  source: HeaderSource,
  options: AuthenticateOptions = {},
): AuthResult<AuthPrincipal> {
  const methods = options.methods ?? ["apiKey", "token", "session"];

  if (methods.includes("apiKey") && options.apiKeys) {
    const provided = extractApiKey(source);
    if (provided) {
      if (!verifyApiKey(provided, options.apiKeys)) {
        return {
          ok: false,
          error: {
            code: "invalid_api_key",
            message: "Invalid API key.",
            status: 401,
          },
        };
      }
      return {
        ok: true,
        value: { method: "apiKey", subject: "api-key", role: "user", scopes: [] },
      };
    }
  }

  if (methods.includes("token") && options.tokenSecret) {
    const bearer = extractBearerToken(source);
    if (bearer) {
      const verification = verifyToken(bearer, options.tokenSecret);
      if (!verification.isValid) {
        return {
          ok: false,
          error: {
            code: verification.code === "token_expired" ? "token_expired" : "invalid_token",
            message: verification.error ?? "Invalid token.",
            status: 401,
          },
        };
      }
      const payload = verification.payload as Record<string, unknown> | undefined;
      return {
        ok: true,
        value: {
          method: "token",
          subject: typeof payload?.sub === "string" ? payload.sub : "token",
          role: roleFromPayload(payload),
          scopes: scopesFromPayload(payload),
          payload,
        },
      };
    }
  }

  if (methods.includes("session") && options.sessionSecret) {
    const cookieName = options.sessionCookieName ?? SESSION_COOKIE_NAME;
    const cookie = getCookie(source, cookieName);
    if (cookie) {
      const verification = verifySessionToken(cookie, options.sessionSecret);
      if (!verification.isValid) {
        return {
          ok: false,
          error: {
            code: verification.code === "session_expired" ? "session_expired" : "invalid_session",
            message: verification.error ?? "Invalid session.",
            status: 401,
          },
        };
      }
      const session = verification.session;
      return {
        ok: true,
        value: {
          method: "session",
          subject: typeof session?.sub === "string" ? session.sub : "session",
          role: roleFromPayload(session),
          scopes: scopesFromPayload(session),
          payload: session as Record<string, unknown> | undefined,
        },
      };
    }
  }

  return {
    ok: false,
    error: {
      code: "missing_credentials",
      message: "Authentication required.",
      status: 401,
    },
  };
}

// ---------------------------------------------------------------------------
// Secure download tokens
// ---------------------------------------------------------------------------

// Declared as a type alias (not an interface) so it keeps the implicit index
// signature that `TokenPayload` requires — interfaces do not get one.
export type DownloadTokenPayload = {
  artifactId: string;
  tenantId: string;
  expiresAt: number;
  scope?: string;
  userAddress?: string;
};

const DEFAULT_DOWNLOAD_SIGNING_SECRET = "stellarcred-secure-download-secret";

/**
 * The secret used to sign secure download links.
 *
 * Read lazily (not at module scope) so the value can be rotated per call and
 * so tests can supply their own without re-importing the module.
 */
export function getDownloadSigningSecret(): string {
  return process.env.DOWNLOAD_SIGNING_SECRET || DEFAULT_DOWNLOAD_SIGNING_SECRET;
}

/**
 * Generates a signed, expiring secure download token and URL for export
 * artifacts.
 */
export function generateSecureDownloadUrl(
  artifactId: string,
  tenantId: string,
  expiresInSeconds: number = 300,
  baseUrl: string = "",
  scope?: string,
  userAddress?: string,
): { url: string; token: string; expiresAt: number } {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const payload: DownloadTokenPayload = {
    artifactId,
    tenantId,
    expiresAt,
    ...(scope ? { scope } : {}),
    ...(userAddress ? { userAddress } : {}),
  };

  const token = signToken(payload, getDownloadSigningSecret());
  const prefix = baseUrl.replace(/\/+$/, "");
  const url = `${prefix}/api/export/download?token=${encodeURIComponent(token)}`;

  return { url, token, expiresAt };
}

/**
 * Validates a secure download token, verifying cryptographic signature and
 * expiration.
 */
export function verifyDownloadToken(token: string): {
  isValid: boolean;
  payload?: DownloadTokenPayload;
  error?: string;
  code?: AuthErrorCode;
} {
  return verifyToken<DownloadTokenPayload>(token, getDownloadSigningSecret());
}

// ---------------------------------------------------------------------------
// Header-derived user context
// ---------------------------------------------------------------------------

/**
 * The address used when a request carries no `x-user-address`. Matches the
 * demo issuer address used across the export UI.
 */
export const DEFAULT_USER_ADDRESS = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

export interface UserContext {
  userAddress: string;
  isAdmin: boolean;
  role: "admin" | "user";
}

/**
 * Resolves the caller identity carried in request headers.
 *
 * This is the *context* of a request (who is asking), not a credential —
 * the header is not a secret. Routes that need an actual proof of identity
 * should use `authenticateRequest` instead.
 */
export function resolveUserContext(source: HeaderSource): UserContext {
  const addressHeader = getHeader(source, "x-user-address");
  const authHeader = getHeader(source, "authorization");
  const roleHeader = getHeader(source, "x-user-role");

  const userAddress = addressHeader || DEFAULT_USER_ADDRESS;
  const isAdmin = roleHeader === "admin" || Boolean(authHeader?.toLowerCase().includes("admin"));

  return { userAddress, isAdmin, role: isAdmin ? "admin" : "user" };
}
