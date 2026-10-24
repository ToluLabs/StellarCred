// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkAdminAuth, UNAUTHORIZED } from "./admin-auth";

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

describe("admin-auth — checkAdminAuth", () => {
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
});
