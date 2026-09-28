// Tests for the public-CORS helpers used by middleware (issue #639): the
// capability descriptor must be readable from any origin.

import { describe, it, expect } from "vitest";

import { getPublicCorsHeaders, isPublicCorsPath } from "../cors";

describe("isPublicCorsPath", () => {
  it("matches the capability descriptor endpoint and subpaths", () => {
    expect(isPublicCorsPath("/api/capabilities")).toBe(true);
    expect(isPublicCorsPath("/api/capabilities/")).toBe(true);
    expect(isPublicCorsPath("/api/capabilities/sub")).toBe(true);
  });

  it("does not open up unrelated API routes", () => {
    expect(isPublicCorsPath("/api/capabilities-other")).toBe(false);
    expect(isPublicCorsPath("/api/ready")).toBe(false);
    expect(isPublicCorsPath("/api/issue")).toBe(false);
    expect(isPublicCorsPath("/")).toBe(false);
  });
});

describe("getPublicCorsHeaders", () => {
  it("allows any origin without leaking configuration", () => {
    const headers = getPublicCorsHeaders();

    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    expect(headers.Vary).toBeUndefined();
  });
});
