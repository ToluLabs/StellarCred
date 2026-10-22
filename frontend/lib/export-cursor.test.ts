// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCursor, verifyCursor } from "./export-cursor";

const ORIGINAL_CURSOR_SECRET = process.env.EXPORT_CURSOR_SECRET;
const ORIGINAL_ADMIN_KEY = process.env.ADMIN_API_KEY;

function setSecrets(cursor?: string, admin?: string): void {
  if (cursor === undefined) delete process.env.EXPORT_CURSOR_SECRET;
  else process.env.EXPORT_CURSOR_SECRET = cursor;
  if (admin === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = admin;
}

describe("export-cursor", () => {
  beforeEach(() => {
    setSecrets(undefined, "test-admin-key");
  });

  afterEach(() => {
    setSecrets(
      ORIGINAL_CURSOR_SECRET === undefined ? undefined : ORIGINAL_CURSOR_SECRET,
      ORIGINAL_ADMIN_KEY === undefined ? undefined : ORIGINAL_ADMIN_KEY,
    );
  });

  it("createCursor returns a non-empty string with exactly one '.'", () => {
    const token = createCursor("job-1", 0);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(token.split(".").length).toBe(2);
  });

  it("verifyCursor round-trips a token it signed (index 0, mid, last)", () => {
    for (const index of [0, 5, 99]) {
      const token = createCursor("job-x", index);
      const v = verifyCursor(token);
      expect(v).toEqual({ ok: true, jobId: "job-x", index });
    }
  });

  it("rejects a tampered payload (flipped base64 char)", () => {
    const token = createCursor("job-1", 3);
    const [payload, sig] = token.split(".");
    // Flip the first payload char (kept within base64url alphabet).
    const flipped = (payload.charAt(0) === "A" ? "B" : "A") + payload.slice(1);
    const tampered = `${flipped}.${sig}`;
    expect(verifyCursor(tampered).ok).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = createCursor("job-1", 3);
    const [payload, sig] = token.split(".");
    const tamperedSig = sig.length > 0
      ? (sig.charAt(0) === "a" ? "b" : "a") + sig.slice(1)
      : "0" + sig;
    expect(verifyCursor(`${payload}.${tamperedSig}`).ok).toBe(false);
  });

  it("rejects a too-short hex signature without throwing (M3 regression)", () => {
    const token = createCursor("job-1", 0);
    const [payload] = token.split(".");
    // A 3-char signature is far shorter than the 64-char HMAC hex.
    const shortSig = `${payload}.abc`;
    const v = verifyCursor(shortSig);
    expect(v.ok).toBe(false);
  });

  it("rejects a token signed with a different secret (rotate)", () => {
    const token = createCursor("job-1", 2);
    setSecrets(undefined, "different-admin-key");
    expect(verifyCursor(token).ok).toBe(false);
  });

  it("rejects malformed inputs: empty, no dot, bad JSON, missing j/i, non-integer i, negative i", () => {
    expect(verifyCursor("").ok).toBe(false);
    expect(verifyCursor("nodotatall").ok).toBe(false);
    // Two dots → malformed.
    expect(verifyCursor("a.b.c").ok).toBe(false);
    // Valid base64url payload that is not valid JSON.
    const badJson = Buffer.from("not-json", "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyCursor(`${badJson}.abc`).ok).toBe(false);
  });

  it("rejects a payload missing j or with non-string j", () => {
    const payload = Buffer.from(JSON.stringify({ i: 0 }), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    // signature won't match (signed differently), but reason paths still exercised.
    expect(verifyCursor(`${payload}.abc`).ok).toBe(false);
  });

  it("rejects non-integer / negative i", () => {
    for (const i of [1.5, -1, "3"] as unknown[]) {
      const payloadJson = JSON.stringify({ j: "job-1", i });
      const payload = Buffer.from(payloadJson, "utf8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      // Signature will not match (signed over a different payload by createCursor),
      // so this exercises the signature-fail path. To exercise the i-check path
      // directly we sign with the real secret.
      const sig = (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createHmac } = require("crypto");
        return createHmac("sha256", process.env.ADMIN_API_KEY!)
          .update(payloadJson)
          .digest("hex");
      })();
      expect(verifyCursor(`${payload}.${sig}`).ok).toBe(false);
    }
  });

  it("when no secret is configured, createCursor throws and verifyCursor returns ok:false", () => {
    setSecrets(undefined, undefined);
    expect(() => createCursor("job-1", 0)).toThrow();
    const v = verifyCursor("eyJqIjoiam9iLTEiLCJpIjowfQ.abc");
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("cursor signing not configured");
    }
  });
});
