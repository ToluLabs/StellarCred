import { describe, it, expect } from "vitest";
import { sanitizeUrl, normalizeReports, parseDirective } from "../csp-report";

describe("lib/csp-report", () => {
  describe("sanitizeUrl", () => {
    it("strips query, hash, and credentials from http/https URLs", () => {
      expect(
        sanitizeUrl("https://example.com/path/to/page?query=param&token=secret#hash"),
      ).toBe("https://example.com/path/to/page");

      expect(
        sanitizeUrl("http://user:password@example.com:8080/app?auth=123#main"),
      ).toBe("http://example.com:8080/app");
    });

    it("treats ws: and wss: like http(s):, returning origin + pathname without query or hash", () => {
      expect(sanitizeUrl("wss://relay.walletconnect.com/?auth=abc")).toBe(
        "wss://relay.walletconnect.com/",
      );
      expect(sanitizeUrl("ws://localhost:8080/socket?query=1#hash")).toBe(
        "ws://localhost:8080/socket",
      );
    });

    it("preserves bare tokens matching /^[a-z][a-z0-9+.-]{0,30}$/ (e.g. data, blob, https, wss)", () => {
      expect(sanitizeUrl("data")).toBe("data");
      expect(sanitizeUrl("blob")).toBe("blob");
      expect(sanitizeUrl("https")).toBe("https");
      expect(sanitizeUrl("wss")).toBe("wss");
    });

    it("converts data: and other non-http/ws schemes to scheme name only", () => {
      expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("data");
      expect(sanitizeUrl("data:")).toBe("data");
      expect(sanitizeUrl("blob:https://example.com/d949e29a-2bf1")).toBe("blob");
      expect(sanitizeUrl("filesystem:https://example.com/temporary/file.txt")).toBe(
        "filesystem",
      );
      expect(sanitizeUrl("chrome-extension://abc/x.js")).toBe("chrome-extension");
    });

    it("preserves designated CSP keywords", () => {
      expect(sanitizeUrl("inline")).toBe("inline");
      expect(sanitizeUrl("eval")).toBe("eval");
      expect(sanitizeUrl("wasm-eval")).toBe("wasm-eval");
      expect(sanitizeUrl("self")).toBe("self");
      expect(sanitizeUrl("")).toBe("");
    });

    it("returns 'invalid' for unparseable input or non-strings", () => {
      expect(sanitizeUrl("not a valid url")).toBe("invalid");
      expect(sanitizeUrl("http://")).toBe("invalid");
      expect(sanitizeUrl("://bad")).toBe("invalid");
      expect(sanitizeUrl(null)).toBe("invalid");
      expect(sanitizeUrl(undefined)).toBe("invalid");
      expect(sanitizeUrl(42)).toBe("invalid");
      expect(sanitizeUrl({ url: "https://example.com" })).toBe("invalid");
    });

    it("truncates any result to at most 200 characters", () => {
      const longUrl = "https://example.com/" + "a".repeat(300);
      const sanitized = sanitizeUrl(longUrl);
      expect(sanitized.length).toBe(200);
      expect(sanitized).toBe(longUrl.slice(0, 200));
    });
  });

  describe("normalizeReports", () => {
    it("parses Legacy format correctly", () => {
      const legacyPayload = {
        "csp-report": {
          "document-uri": "https://example.com/dashboard?token=xyz#top",
          "blocked-uri": "https://malicious.com/tracker.js?id=123",
          "violated-directive": "script-src 'self'",
          "effective-directive": "script-src",
          "disposition": "report",
          "source-file": "https://example.com/app.js?v=1",
          "line-number": 105,
          "column-number": 12,
          "status-code": 200,
          "script-sample": "console.log('secret')",
          "original-policy": "default-src 'self'",
        },
      };

      const result = normalizeReports(legacyPayload);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        documentUri: "https://example.com/dashboard",
        blockedUri: "https://malicious.com/tracker.js",
        sourceFile: "https://example.com/app.js",
        effectiveDirective: "script-src",
        disposition: "report",
        lineNumber: 105,
        columnNumber: 12,
        statusCode: 200,
      });
    });

    it("parses Reporting API format correctly", () => {
      const reportingApiPayload = [
        {
          type: "csp-violation",
          url: "https://example.com/index?session=abc",
          body: {
            documentURL: "https://example.com/index?session=abc",
            blockedURL: "eval",
            effectiveDirective: "script-src",
            disposition: "enforce",
            sourceFile: "https://example.com/main.js",
            lineNumber: 42,
            columnNumber: 8,
            statusCode: 200,
            sample: "eval('bad')",
            originalPolicy: "script-src 'self'",
          },
        },
      ];

      const result = normalizeReports(reportingApiPayload);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        documentUri: "https://example.com/index",
        blockedUri: "eval",
        sourceFile: "https://example.com/main.js",
        effectiveDirective: "script-src",
        disposition: "enforce",
        lineNumber: 42,
        columnNumber: 8,
        statusCode: 200,
      });
    });

    it("ignores array entries whose type is not csp-violation", () => {
      const mixedPayload = [
        { type: "deprecation", url: "https://example.com/api" },
        {
          type: "csp-violation",
          body: {
            documentURL: "https://example.com/page",
            blockedURL: "inline",
            effectiveDirective: "style-src",
            disposition: "report",
          },
        },
        { type: "intervention", url: "https://example.com/other" },
      ];

      const result = normalizeReports(mixedPayload);
      expect(result).toHaveLength(1);
      expect(result[0].blockedUri).toBe("inline");
      expect(result[0].effectiveDirective).toBe("style-src");
    });

    it("caps entries at 10 items", () => {
      const manyEntries = Array.from({ length: 15 }, (_, i) => ({
        type: "csp-violation",
        body: {
          documentURL: `https://example.com/${i}`,
          blockedURL: "inline",
          effectiveDirective: "script-src",
          disposition: "report",
        },
      }));

      const result = normalizeReports(manyEntries);
      expect(result).toHaveLength(10);
    });

    it("drops non-finite integer values for lineNumber, columnNumber, and statusCode", () => {
      const payload = {
        "csp-report": {
          "document-uri": "https://example.com",
          "blocked-uri": "inline",
          "effective-directive": "script-src",
          "disposition": "report",
          "line-number": "NaN",
          "column-number": 12.34,
          "status-code": Infinity,
        },
      };

      const result = normalizeReports(payload);
      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty("lineNumber");
      expect(result[0]).not.toHaveProperty("columnNumber");
      expect(result[0]).not.toHaveProperty("statusCode");
    });

    it("never includes script-sample, original-policy, or other sensitive fields", () => {
      const payload = {
        "csp-report": {
          "document-uri": "https://example.com",
          "blocked-uri": "inline",
          "effective-directive": "script-src",
          "disposition": "report",
          "script-sample": "secret_token_12345",
          sample: "secret_token_12345",
          "original-policy": "default-src 'self'",
          originalPolicy: "default-src 'self'",
          referrer: "https://example.com/secret",
        },
      };

      const result = normalizeReports(payload);
      expect(result).toHaveLength(1);
      const keys = Object.keys(result[0]);
      expect(keys).not.toContain("script-sample");
      expect(keys).not.toContain("sample");
      expect(keys).not.toContain("original-policy");
      expect(keys).not.toContain("originalPolicy");
      expect(keys).not.toContain("referrer");
      expect(JSON.stringify(result[0])).not.toContain("secret_token_12345");
    });

    it("returns [] and never throws for garbage input", () => {
      expect(normalizeReports(null)).toEqual([]);
      expect(normalizeReports(undefined)).toEqual([]);
      expect(normalizeReports("garbage")).toEqual([]);
      expect(normalizeReports(12345)).toEqual([]);
      expect(normalizeReports({})).toEqual([]);
      expect(normalizeReports({ "csp-report": null })).toEqual([]);
      expect(normalizeReports([null, undefined, "foo", {}])).toEqual([]);
    });

    it("extracts the first token of effective-directive when directive arguments are present", () => {
      const payload = {
        "csp-report": {
          "document-uri": "https://example.com",
          "blocked-uri": "inline",
          "effective-directive": "script-src 'self' 'nonce-abc'",
          "disposition": "report",
        },
      };

      const result = normalizeReports(payload);
      expect(result).toHaveLength(1);
      expect(result[0].effectiveDirective).toBe("script-src");
    });
  });

  describe("parseDirective", () => {
    it("takes only the first whitespace-separated token before applying regex", () => {
      expect(parseDirective("script-src 'self' 'nonce-abc'")).toBe("script-src");
      expect(parseDirective("  style-src   'unsafe-inline' ")).toBe("style-src");
      expect(parseDirective("CONNECT-SRC https://example.com")).toBe("connect-src");
      expect(parseDirective("123-bad-token 'self'")).toBe("unknown");
      expect(parseDirective("")).toBe("unknown");
      expect(parseDirective(null)).toBe("unknown");
      expect(parseDirective(undefined)).toBe("unknown");
    });
  });
});
