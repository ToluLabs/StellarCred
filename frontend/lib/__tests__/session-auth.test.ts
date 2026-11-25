// @vitest-environment node
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createSignedSessionToken, validateSessionToken, type SessionPayload } from "../auth";
import { requireSession } from "../../app/api/_middleware";

const TEST_SECRET = "super-secure-test-session-secret-key-32b";

function mockRequest(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/protected", { headers });
}

describe("harden API auth checks and session validation (#945)", () => {
  const basePayload: Omit<SessionPayload, "iat"> = {
    sub: "GUSER1234567890STEL",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: "StellarCredAuth",
    role: "holder",
  };

  describe("validateSessionToken", () => {
    it("accepts a properly signed, unexpired session token", () => {
      const token = createSignedSessionToken(basePayload, TEST_SECRET);
      const result = validateSessionToken(token, { secret: TEST_SECRET });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sub).toBe("GUSER1234567890STEL");
        expect(result.value.iss).toBe("StellarCredAuth");
        expect(result.value.role).toBe("holder");
      }
    });

    it("rejects unsigned tokens or alg: none", () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify(basePayload)).toString("base64url");
      const unsignedToken = `${header}.${payload}.`;

      const result = validateSessionToken(unsignedToken, { secret: TEST_SECRET });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
      }
    });

    it("rejects forged and tampered tokens", () => {
      const token = createSignedSessionToken(basePayload, TEST_SECRET);
      const parts = token.split(".");

      // Tamper payload
      const tamperedPayload = Buffer.from(
        JSON.stringify({ ...basePayload, role: "admin" }),
      ).toString("base64url");
      const forgedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const result = validateSessionToken(forgedToken, { secret: TEST_SECRET });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
      }
    });

    it("rejects expired session tokens", () => {
      const expiredPayload: Omit<SessionPayload, "iat"> = {
        ...basePayload,
        exp: Math.floor(Date.now() / 1000) - 10,
      };
      const token = createSignedSessionToken(expiredPayload, TEST_SECRET);
      const result = validateSessionToken(token, { secret: TEST_SECRET });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.error).toBe("session expired");
      }
    });

    it("rejects tokens issued in the future beyond max clock skew", () => {
      const futurePayload: SessionPayload = {
        ...basePayload,
        iat: Math.floor(Date.now() / 1000) + 1000,
      };
      const token = createSignedSessionToken(futurePayload, TEST_SECRET);
      const result = validateSessionToken(token, { secret: TEST_SECRET });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.error).toBe("token issued in future");
      }
    });

    it("rejects tokens from untrusted issuers when allowlist is provided", () => {
      const token = createSignedSessionToken(
        { ...basePayload, iss: "UntrustedExternalParty" },
        TEST_SECRET,
      );
      const result = validateSessionToken(token, {
        secret: TEST_SECRET,
        allowedIssuers: ["StellarCredAuth"],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.error).toBe("untrusted session issuer");
      }
    });

    it("detects and rejects replayed session tokens via nonce cache", () => {
      const nonceSet = new Set<string>();
      const token = createSignedSessionToken(
        { ...basePayload, nonce: "nonce-single-use-1234" },
        TEST_SECRET,
      );

      // First use succeeds
      const first = validateSessionToken(token, { secret: TEST_SECRET, usedNonces: nonceSet });
      expect(first.ok).toBe(true);

      // Replay attempt fails
      const replay = validateSessionToken(token, { secret: TEST_SECRET, usedNonces: nonceSet });
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.status).toBe(401);
        expect(replay.error).toBe("replayed session token");
      }
    });
  });

  describe("requireSession middleware helper", () => {
    it("returns session payload when valid token is present in header", () => {
      const token = createSignedSessionToken(basePayload, TEST_SECRET);
      const req = mockRequest({ authorization: `Bearer ${token}` });

      const res = requireSession(req, { secret: TEST_SECRET });
      expect("ok" in res && res.ok).toBe(true);
      if ("ok" in res && res.ok) {
        expect(res.session.sub).toBe("GUSER1234567890STEL");
      }
    });

    it("returns 401 JSON response on missing or invalid session", async () => {
      const req = mockRequest();
      const res = requireSession(req, { secret: TEST_SECRET });

      expect("status" in res && res.status).toBe(401);
      if ("status" in res) {
        expect(await res.json()).toEqual({ error: "Unauthorized" });
      }
    });
  });
});
