// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  authFailure,
  checkAdminAuth,
  extractApiKey,
  extractBearerToken,
  isTokenExpired,
  UNAUTHORIZED,
  verifyApiKey,
} from "./auth";

/**
 * Minimal NextRequest stand-in: checkAdminAuth only reads
 * req.headers.get("authorization"), so a tiny stub is sufficient and keeps the
 * test free of Next runtime dependencies.
 */
function makeRequest(authHeader: string | null): {
  headers: { get(name: string): string | null };
} {
  return {
    headers: {
      get(name: string): string | null {
        if (name.toLowerCase() === "authorization") return authHeader;
        return null;
      },
    },
  };
}

const ORIGINAL_KEY = process.env.ADMIN_API_KEY;

describe("auth — checkAdminAuth", () => {
  beforeEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = ORIGINAL_KEY;
    }
  });

  it("UNAUTHORIZED is a constant 401 body with an error field", () => {
    expect(UNAUTHORIZED).toEqual({ error: "Unauthorized" });
  });

  it("returns false when ADMIN_API_KEY is not configured", () => {
    const req = makeRequest("Bearer some-key");
    expect(checkAdminAuth(req as never)).toBe(false);
  });

  it("returns false when ADMIN_API_KEY is empty/whitespace", () => {
    process.env.ADMIN_API_KEY = "   ";
    const req = makeRequest("Bearer some-key");
    expect(checkAdminAuth(req as never)).toBe(false);
  });

  it("returns false when no Authorization header is present", () => {
    process.env.ADMIN_API_KEY = "secret-key";
    const req = makeRequest(null);
    expect(checkAdminAuth(req as never)).toBe(false);
  });

  it("returns false when the Authorization header has no Bearer prefix", () => {
    process.env.ADMIN_API_KEY = "secret-key";
    const req = makeRequest("secret-key");
    expect(checkAdminAuth(req as never)).toBe(false);
  });

  it("returns false when the bearer token does not match", () => {
    process.env.ADMIN_API_KEY = "secret-key";
    const req = makeRequest("Bearer wrong-key");
    expect(checkAdminAuth(req as never)).toBe(false);
  });

  it("returns true when the bearer token matches the configured key", () => {
    process.env.ADMIN_API_KEY = "secret-key";
    const req = makeRequest("Bearer secret-key");
    expect(checkAdminAuth(req as never)).toBe(true);
  });

  it("is case-insensitive on the Bearer scheme", () => {
    process.env.ADMIN_API_KEY = "secret-key";
    const req = makeRequest("bearer secret-key");
    expect(checkAdminAuth(req as never)).toBe(true);
  });

  it("returns false when the provided token length differs from the configured key", () => {
    process.env.ADMIN_API_KEY = "secret-key";
    // Shorter than configured — length check should reject before comparing.
    const req = makeRequest("Bearer secret");
    expect(checkAdminAuth(req as never)).toBe(false);
  });

  it("returns false for a malformed Authorization header (no token after Bearer)", () => {
    process.env.ADMIN_API_KEY = "secret-key";
    const req = makeRequest("Bearer ");
    expect(checkAdminAuth(req as never)).toBe(false);
  });

  it("returns false for a correct key sent with a non-Bearer scheme", () => {
    process.env.ADMIN_API_KEY = "secret-key";
    expect(checkAdminAuth(makeRequest("Basic secret-key") as never)).toBe(false);
  });
});

describe("auth — extractBearerToken", () => {
  it("returns the token for a Bearer header, case-insensitively", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("BEARER abc")).toBe("abc");
  });

  it("returns undefined for missing, empty, or non-Bearer headers", () => {
    expect(extractBearerToken(null)).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("")).toBeUndefined();
    expect(extractBearerToken("Bearer")).toBeUndefined();
    expect(extractBearerToken("Bearer    ")).toBeUndefined();
    expect(extractBearerToken("Basic abc")).toBeUndefined();
    expect(extractBearerToken("abc")).toBeUndefined();
  });
});

describe("auth — isTokenExpired", () => {
  const now = 1_700_000_000_000;

  it("is false before and at the expiry instant", () => {
    expect(isTokenExpired(now + 1, now)).toBe(false);
    expect(isTokenExpired(now, now)).toBe(false);
  });

  it("is true after the expiry instant", () => {
    expect(isTokenExpired(now - 1, now)).toBe(true);
  });

  it("treats a non-numeric expiry as expired", () => {
    expect(isTokenExpired(NaN, now)).toBe(true);
    expect(isTokenExpired(undefined as unknown as number, now)).toBe(true);
  });
});

describe("auth — extractApiKey", () => {
  it("prefers x-api-key over a Bearer token", () => {
    const headers = new Headers({ "x-api-key": "key-a", authorization: "Bearer key-b" });
    expect(extractApiKey(headers)).toBe("key-a");
  });

  it("falls back to a Bearer token", () => {
    expect(extractApiKey(new Headers({ authorization: "Bearer key-b" }))).toBe("key-b");
  });

  it("reads plain header records", () => {
    expect(extractApiKey({ "x-api-key": " key-a " })).toBe("key-a");
    expect(extractApiKey({ authorization: "bearer key-b" })).toBe("key-b");
  });

  it("returns undefined when no key is supplied", () => {
    expect(extractApiKey(new Headers())).toBeUndefined();
    expect(extractApiKey({ "x-api-key": "   ", authorization: null })).toBeUndefined();
    expect(extractApiKey(new Headers({ authorization: "Basic key-b" }))).toBeUndefined();
  });
});

describe("auth — verifyApiKey", () => {
  it("accepts an exact match", () => {
    expect(verifyApiKey("secret", "secret")).toBe(true);
  });

  it("rejects invalid keys", () => {
    expect(verifyApiKey("secreT", "secret")).toBe(false);
    expect(verifyApiKey("secret-longer", "secret")).toBe(false);
    expect(verifyApiKey("", "secret")).toBe(false);
    expect(verifyApiKey(undefined, "secret")).toBe(false);
  });

  it("never matches when no key is configured", () => {
    expect(verifyApiKey("", "")).toBe(false);
    expect(verifyApiKey("   ", "   ")).toBe(false);
    expect(verifyApiKey("secret", undefined)).toBe(false);
  });
});

describe("auth — authFailure", () => {
  it("builds a rejected result", () => {
    expect(authFailure(403, "nope")).toEqual({ ok: false, status: 403, error: "nope" });
  });
});
