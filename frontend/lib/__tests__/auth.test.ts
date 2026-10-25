// @vitest-environment node
//
// Unit tests for the shared auth module (frontend/lib/auth.ts).
//
// Covers the credential kinds the module centralizes — signed tokens, API
// keys, sessions — and, above all, their failure modes: expired tokens,
// forged signatures, invalid keys, malformed payloads.

import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  authenticateRequest,
  createSessionToken,
  DEFAULT_USER_ADDRESS,
  extractApiKey,
  extractBearerToken,
  firstHeader,
  generateSecureDownloadUrl,
  getCookie,
  getHeader,
  parseBearerToken,
  parseCookies,
  resolveUserContext,
  signToken,
  timingSafeEqualString,
  verifyApiKey,
  verifyDownloadToken,
  verifyHmacSignature,
  verifySessionToken,
  verifyToken,
} from "@/lib/auth";

const SECRET = "test-signing-secret";
const OTHER_SECRET = "a-different-signing-secret";

describe("lib/auth — header access", () => {
  it("reads and trims a header from a Headers object", () => {
    const headers = new Headers({ "x-api-key": "  abc123  " });
    expect(getHeader(headers, "x-api-key")).toBe("abc123");
  });

  it("returns undefined for missing and empty headers", () => {
    const headers = new Headers({ "x-empty": "   " });
    expect(getHeader(headers, "x-empty")).toBeUndefined();
    expect(getHeader(headers, "x-missing")).toBeUndefined();
  });

  it("reads a header from a plain record", () => {
    expect(getHeader({ "x-user-role": "admin" }, "x-user-role")).toBe("admin");
  });

  it("reads a header from a request-like object", () => {
    const req = { headers: new Headers({ "x-user-role": "admin" }) };
    expect(getHeader(req, "x-user-role")).toBe("admin");
  });

  it("firstHeader returns the first present header in order", () => {
    const headers = new Headers({ "webhook-signature": "sig" });
    expect(firstHeader(headers, ["x-issuance-signature", "webhook-signature"])).toBe("sig");
    expect(firstHeader(headers, ["x-issuance-signature"])).toBeUndefined();
  });
});

describe("lib/auth — bearer tokens", () => {
  it("parses a Bearer credential regardless of case", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("bearer abc")).toBe("abc");
    expect(parseBearerToken("BEARER   abc  ")).toBe("abc");
  });

  it("rejects other auth schemes and empty bearer values", () => {
    expect(parseBearerToken("Basic dXNlcjpwYXNz")).toBeUndefined();
    expect(parseBearerToken("Bearer")).toBeUndefined();
    expect(parseBearerToken("Bearer   ")).toBeUndefined();
    expect(parseBearerToken(null)).toBeUndefined();
    expect(parseBearerToken(undefined)).toBeUndefined();
  });

  it("extracts the bearer credential from a request", () => {
    expect(extractBearerToken(new Headers({ authorization: "Bearer tok" }))).toBe("tok");
    expect(extractBearerToken(new Headers({ authorization: "Basic tok" }))).toBeUndefined();
  });
});

describe("lib/auth — API keys", () => {
  it("prefers x-api-key over the Authorization header", () => {
    const headers = new Headers({
      "x-api-key": "key-from-header",
      authorization: "Bearer key-from-auth",
    });
    expect(extractApiKey(headers)).toBe("key-from-header");
  });

  it("falls back to the bearer credential", () => {
    expect(extractApiKey(new Headers({ authorization: "Bearer key-from-auth" }))).toBe(
      "key-from-auth",
    );
  });

  it("returns undefined when no key is present", () => {
    expect(extractApiKey(new Headers())).toBeUndefined();
    expect(extractApiKey(new Headers({ authorization: "Basic abc" }))).toBeUndefined();
  });

  it("verifies a matching key", () => {
    expect(verifyApiKey("sk_live_abc", "sk_live_abc")).toBe(true);
  });

  it("rejects an invalid key", () => {
    expect(verifyApiKey("sk_live_wrong", "sk_live_abc")).toBe(false);
  });

  it("rejects a missing key or missing expectation", () => {
    expect(verifyApiKey(undefined, "sk_live_abc")).toBe(false);
    expect(verifyApiKey("", "sk_live_abc")).toBe(false);
    expect(verifyApiKey("sk_live_abc", undefined)).toBe(false);
    expect(verifyApiKey("sk_live_abc", [])).toBe(false);
  });

  it("accepts a key from a set of accepted keys", () => {
    expect(verifyApiKey("sk_live_b", ["sk_live_a", "sk_live_b"])).toBe(true);
    expect(verifyApiKey("sk_live_c", ["sk_live_a", "sk_live_b"])).toBe(false);
  });

  it("compares strings of different lengths without throwing", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abcd")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(true);
  });
});

describe("lib/auth — signed tokens", () => {
  it("round-trips a payload", () => {
    const token = signToken({ sub: "user-1", role: "admin" }, SECRET);
    const result = verifyToken(token, SECRET);
    expect(result.isValid).toBe(true);
    expect(result.payload?.sub).toBe("user-1");
    expect(result.payload?.role).toBe("admin");
  });

  it("rejects a token signed with a different secret", () => {
    const token = signToken({ sub: "user-1" }, OTHER_SECRET);
    const result = verifyToken(token, SECRET);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid token signature");
  });

  it("rejects a tampered payload", () => {
    const token = signToken({ sub: "user-1" }, SECRET);
    const [payload, signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "admin" }), "utf8").toString(
      "base64url",
    );
    const result = verifyToken(`${forgedPayload}.${signature}`, SECRET);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid token signature");
    expect(payload).toBeTruthy();
  });

  it("rejects a malformed token structure", () => {
    expect(verifyToken("not-a-token", SECRET).error).toBe("Invalid token structure");
    expect(verifyToken("a.b.c", SECRET).error).toBe("Invalid token structure");
  });

  it("rejects a missing token", () => {
    expect(verifyToken(undefined, SECRET).error).toBe("Missing token");
    expect(verifyToken("", SECRET).error).toBe("Missing token");
  });

  it("rejects an expired token", () => {
    const now = 1_700_000_000_000;
    const token = signToken({ sub: "user-1", exp: Math.floor(now / 1000) - 10 }, SECRET);
    const result = verifyToken(token, SECRET, { now });
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Token has expired");
    expect(result.code).toBe("token_expired");
  });

  it("accepts a token that has not expired yet", () => {
    const now = 1_700_000_000_000;
    const token = signToken({ sub: "user-1", exp: Math.floor(now / 1000) + 60 }, SECRET);
    expect(verifyToken(token, SECRET, { now }).isValid).toBe(true);
  });

  it("honours expiresAt (milliseconds) as an expiry", () => {
    const now = 1_700_000_000_000;
    const token = signToken({ sub: "user-1", expiresAt: now - 1 }, SECRET);
    const result = verifyToken(token, SECRET, { now });
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Token has expired");
  });

  it("treats a token without an expiry as non-expiring", () => {
    const token = signToken({ sub: "user-1" }, SECRET);
    const result = verifyToken(token, SECRET, { now: 4_000_000_000_000 });
    expect(result.isValid).toBe(true);
  });
});

describe("lib/auth — secure download tokens", () => {
  const originalSecret = process.env.DOWNLOAD_SIGNING_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.DOWNLOAD_SIGNING_SECRET;
    else process.env.DOWNLOAD_SIGNING_SECRET = originalSecret;
  });

  it("round-trips a download token", () => {
    process.env.DOWNLOAD_SIGNING_SECRET = SECRET;
    const { url, token } = generateSecureDownloadUrl(
      "art_1",
      "tenant_main",
      300,
      "",
      "credentials",
    );
    expect(url).toContain("/api/export/download?token=");

    const result = verifyDownloadToken(token);
    expect(result.isValid).toBe(true);
    expect(result.payload?.artifactId).toBe("art_1");
    expect(result.payload?.tenantId).toBe("tenant_main");
    expect(result.payload?.scope).toBe("credentials");
  });

  it("rejects an expired download token", () => {
    process.env.DOWNLOAD_SIGNING_SECRET = SECRET;
    const { token } = generateSecureDownloadUrl("art_exp", "tenant_main", -10);
    const result = verifyDownloadToken(token);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Token has expired");
  });

  it("rejects a download token signed with a different secret", () => {
    process.env.DOWNLOAD_SIGNING_SECRET = SECRET;
    const { token } = generateSecureDownloadUrl("art_1", "tenant_main", 300);
    process.env.DOWNLOAD_SIGNING_SECRET = OTHER_SECRET;
    expect(verifyDownloadToken(token).isValid).toBe(false);
  });

  it("rejects a tampered download token", () => {
    process.env.DOWNLOAD_SIGNING_SECRET = SECRET;
    const { token } = generateSecureDownloadUrl("art_1", "tenant_main", 300);
    const tampered = token.slice(0, -4) + "abcd";
    const result = verifyDownloadToken(tampered);
    expect(result.isValid).toBe(false);
    expect(result.error).toBe("Invalid token signature");
  });
});

describe("lib/auth — sessions", () => {
  it("parses a cookie header", () => {
    const cookies = parseCookies("a=1; b=two; c=%2Fpath");
    expect(cookies.a).toBe("1");
    expect(cookies.b).toBe("two");
    expect(cookies.c).toBe("/path");
  });

  it("reads a named cookie from a request", () => {
    const headers = new Headers({ cookie: "sc_session=abc; other=xyz" });
    expect(getCookie(headers, "sc_session")).toBe("abc");
    expect(getCookie(headers, "missing")).toBeUndefined();
  });

  it("round-trips a session", () => {
    const { token } = createSessionToken({ sub: "user-1", role: "admin" }, SECRET, 60);
    const result = verifySessionToken(token, SECRET);
    expect(result.isValid).toBe(true);
    expect(result.session?.sub).toBe("user-1");
    expect(result.session?.role).toBe("admin");
  });

  it("rejects an expired session", () => {
    const now = 1_700_000_000_000;
    const { token } = createSessionToken({ sub: "user-1" }, SECRET, 60, { now });
    const result = verifySessionToken(token, SECRET, { now: now + 61_000 });
    expect(result.isValid).toBe(false);
    expect(result.code).toBe("session_expired");
  });

  it("rejects a session signed with a different secret", () => {
    const { token } = createSessionToken({ sub: "user-1" }, SECRET, 60);
    const result = verifySessionToken(token, OTHER_SECRET);
    expect(result.isValid).toBe(false);
    expect(result.code).toBe("invalid_session");
  });

  it("rejects a malformed session cookie", () => {
    expect(verifySessionToken("not-a-session", SECRET).isValid).toBe(false);
    expect(verifySessionToken(undefined, SECRET).isValid).toBe(false);
  });
});

describe("lib/auth — HMAC request signatures", () => {
  const body = '{"eventId":"evt_1"}';

  it("accepts a raw hex signature", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyHmacSignature(body, sig, SECRET)).toBe(true);
  });

  it("accepts a sha256= prefixed signature", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyHmacSignature(body, `sha256=${sig}`, SECRET)).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    const sig = crypto.createHmac("sha256", OTHER_SECRET).update(body).digest("hex");
    expect(verifyHmacSignature(body, sig, SECRET)).toBe(false);
  });

  it("rejects a missing signature or secret", () => {
    expect(verifyHmacSignature(body, null, SECRET)).toBe(false);
    expect(verifyHmacSignature(body, "abc", "")).toBe(false);
  });

  it("rejects a signature over a different body", () => {
    const sig = crypto.createHmac("sha256", SECRET).update("other").digest("hex");
    expect(verifyHmacSignature(body, sig, SECRET)).toBe(false);
  });

  it("accepts a timestamped signature inside the skew window", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
    expect(verifyHmacSignature(body, `t=${ts},v1=${sig}`, SECRET)).toBe(true);
  });

  it("rejects a timestamped signature outside the skew window", () => {
    const ts = Math.floor(Date.now() / 1000) - 3600;
    const sig = crypto.createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
    expect(verifyHmacSignature(body, `t=${ts},v1=${sig}`, SECRET)).toBe(false);
  });
});

describe("lib/auth — authenticateRequest", () => {
  const apiKey = "sk_live_abc";
  const tokenSecret = SECRET;

  it("accepts a valid API key", () => {
    const result = authenticateRequest(new Headers({ "x-api-key": apiKey }), {
      apiKeys: apiKey,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.method).toBe("apiKey");
  });

  it("rejects an invalid API key with 401", () => {
    const result = authenticateRequest(new Headers({ "x-api-key": "sk_live_bad" }), {
      apiKeys: apiKey,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(401);
      expect(result.error.code).toBe("invalid_api_key");
    }
  });

  it("rejects a missing credential with 401", () => {
    const result = authenticateRequest(new Headers(), { apiKeys: apiKey });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("missing_credentials");
  });

  it("accepts a valid bearer token", () => {
    const token = signToken({ sub: "user-1", role: "admin" }, tokenSecret);
    const result = authenticateRequest(new Headers({ authorization: `Bearer ${token}` }), {
      tokenSecret,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.method).toBe("token");
      expect(result.value.subject).toBe("user-1");
      expect(result.value.role).toBe("admin");
    }
  });

  it("rejects an expired bearer token", () => {
    const token = signToken({ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 5 }, tokenSecret);
    const result = authenticateRequest(new Headers({ authorization: `Bearer ${token}` }), {
      tokenSecret,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("token_expired");
  });

  it("does not fall back to a weaker credential when a presented one is invalid", () => {
    const headers = new Headers({
      "x-api-key": "sk_live_bad",
      authorization: `Bearer ${signToken({ sub: "user-1" }, tokenSecret)}`,
    });
    const result = authenticateRequest(headers, { apiKeys: apiKey, tokenSecret });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_api_key");
  });

  it("accepts a valid session cookie", () => {
    const { token } = createSessionToken({ sub: "user-1" }, SECRET, 60);
    const result = authenticateRequest(new Headers({ cookie: `sc_session=${token}` }), {
      sessionSecret: SECRET,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.method).toBe("session");
  });

  it("rejects an expired session cookie", () => {
    // Minted in the past so the session is already expired when it is presented.
    const { token } = createSessionToken({ sub: "user-1" }, SECRET, 1, {
      now: Date.now() - 10_000,
    });
    const result = authenticateRequest(new Headers({ cookie: `sc_session=${token}` }), {
      sessionSecret: SECRET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("session_expired");
  });
});

describe("lib/auth — resolveUserContext", () => {
  it("falls back to the default address", () => {
    const ctx = resolveUserContext(new Headers());
    expect(ctx.userAddress).toBe(DEFAULT_USER_ADDRESS);
    expect(ctx.isAdmin).toBe(false);
    expect(ctx.role).toBe("user");
  });

  it("uses x-user-address when present", () => {
    const ctx = resolveUserContext(new Headers({ "x-user-address": "GABC" }));
    expect(ctx.userAddress).toBe("GABC");
  });

  it("detects admin via the role header", () => {
    const ctx = resolveUserContext(new Headers({ "x-user-role": "admin" }));
    expect(ctx.isAdmin).toBe(true);
    expect(ctx.role).toBe("admin");
  });

  it("detects admin via the authorization header", () => {
    const ctx = resolveUserContext(new Headers({ authorization: "Bearer admin-token" }));
    expect(ctx.isAdmin).toBe(true);
  });

  it("does not treat a non-admin role as admin", () => {
    const ctx = resolveUserContext(new Headers({ "x-user-role": "user" }));
    expect(ctx.isAdmin).toBe(false);
  });
});
