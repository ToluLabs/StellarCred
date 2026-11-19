/**
 * Unit tests for browser capability detection.
 *
 * Issue #900: Add graceful degradation for unsupported browser capabilities
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  checkBrowserCapabilities,
  getUnsupportedBrowserMessage,
  requireBrowserCapabilities,
  type BrowserCapabilities,
  type CapabilityCheck,
} from "../browser-capabilities";

function findCheck(name: string): CapabilityCheck {
  const check = checkBrowserCapabilities().checks.find((c) => c.name === name);
  if (!check) throw new Error(`capability check "${name}" not found`);
  return check;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser-capabilities", () => {
  describe("checkBrowserCapabilities", () => {
    it("returns a capabilities object with all checks", () => {
      const capabilities = checkBrowserCapabilities();

      expect(capabilities).toHaveProperty("checks");
      expect(capabilities).toHaveProperty("isFullySupported");
      expect(capabilities).toHaveProperty("hasBasicSupport");
      expect(capabilities).toHaveProperty("unsupportedCritical");
      expect(Array.isArray(capabilities.checks)).toBe(true);
      expect(capabilities.checks.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          "WebAssembly",
          "Web Workers",
          "Cross-origin isolation",
          "localStorage",
          "sessionStorage",
          "Web Crypto API",
          "BigInt",
          "SharedArrayBuffer",
        ]),
      );
    });

    it("marks WebAssembly, Web Crypto and BigInt as critical with no fallback", () => {
      for (const name of ["WebAssembly", "Web Crypto API", "BigInt"]) {
        const check = findCheck(name);
        expect(check.critical).toBe(true);
        expect(check.hasFallback).toBe(false);
      }
    });

    it("marks Web Workers, storage and threading features as non-critical with a fallback", () => {
      for (const name of [
        "Web Workers",
        "Cross-origin isolation",
        "localStorage",
        "sessionStorage",
        "SharedArrayBuffer",
      ]) {
        const check = findCheck(name);
        expect(check.critical).toBe(false);
        expect(check.hasFallback).toBe(true);
      }
    });

    it("keeps unsupportedCritical consistent with the individual checks", () => {
      const capabilities = checkBrowserCapabilities();
      const expected = capabilities.checks.filter((c) => c.critical && !c.supported);

      expect(capabilities.unsupportedCritical).toEqual(expected);
      expect(capabilities.isFullySupported).toBe(expected.length === 0);
    });

    it("detects missing WebAssembly as a critical failure", () => {
      vi.stubGlobal("WebAssembly", undefined);

      const check = findCheck("WebAssembly");
      expect(check.supported).toBe(false);
      expect(check.critical).toBe(true);
      expect(check.error).toMatch(/WebAssembly/);

      const capabilities = checkBrowserCapabilities();
      expect(capabilities.isFullySupported).toBe(false);
      expect(capabilities.hasBasicSupport).toBe(false);
      expect(capabilities.unsupportedCritical.map((c) => c.name)).toContain("WebAssembly");
    });

    it("detects missing Web Crypto as a critical failure", () => {
      vi.stubGlobal("crypto", undefined);

      const check = findCheck("Web Crypto API");
      expect(check.supported).toBe(false);
      expect(check.critical).toBe(true);
      expect(checkBrowserCapabilities().hasBasicSupport).toBe(false);
    });

    it("detects missing BigInt as a critical failure", () => {
      vi.stubGlobal("BigInt", undefined);

      const check = findCheck("BigInt");
      expect(check.supported).toBe(false);
      expect(check.critical).toBe(true);
      expect(checkBrowserCapabilities().isFullySupported).toBe(false);
    });

    it("treats missing Web Workers as non-critical with a fallback description", () => {
      vi.stubGlobal("Worker", undefined);

      const check = findCheck("Web Workers");
      expect(check.supported).toBe(false);
      expect(check.critical).toBe(false);
      expect(check.fallbackDescription).toBeTruthy();
      expect(checkBrowserCapabilities().unsupportedCritical.map((c) => c.name)).not.toContain(
        "Web Workers",
      );
    });

    it("reports cross-origin isolation according to globalThis.crossOriginIsolated", () => {
      vi.stubGlobal("crossOriginIsolated", true);
      expect(findCheck("Cross-origin isolation").supported).toBe(true);

      vi.stubGlobal("crossOriginIsolated", false);
      const check = findCheck("Cross-origin isolation");
      expect(check.supported).toBe(false);
      expect(check.critical).toBe(false);
    });

    it("treats missing SharedArrayBuffer as non-critical", () => {
      vi.stubGlobal("SharedArrayBuffer", undefined);

      const check = findCheck("SharedArrayBuffer");
      expect(check.supported).toBe(false);
      expect(check.critical).toBe(false);
      expect(check.fallbackDescription).toBeTruthy();
    });

    it("treats blocked localStorage as non-critical", () => {
      // Replace the whole storage object rather than spying on Storage.prototype:
      // the test environment may provide a non-Storage localStorage stand-in.
      vi.stubGlobal("localStorage", {
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {},
      });

      const local = findCheck("localStorage");
      expect(local.supported).toBe(false);
      expect(local.critical).toBe(false);
      expect(local.error).toContain("blocked");
      expect(checkBrowserCapabilities().unsupportedCritical.map((c) => c.name)).not.toContain(
        "localStorage",
      );
    });

    it("reports working storage as supported", () => {
      expect(findCheck("localStorage").supported).toBe(true);
      expect(findCheck("sessionStorage").supported).toBe(true);
    });
  });

  describe("getUnsupportedBrowserMessage", () => {
    const base: BrowserCapabilities = {
      checks: [],
      isFullySupported: true,
      hasBasicSupport: true,
      unsupportedCritical: [],
    };

    it("returns an empty string when fully supported", () => {
      expect(getUnsupportedBrowserMessage(base)).toBe("");
    });

    it("returns an error message for critical failures", () => {
      const message = getUnsupportedBrowserMessage({
        ...base,
        isFullySupported: false,
        unsupportedCritical: [
          {
            name: "WebAssembly",
            supported: false,
            error: "WebAssembly is not available",
            critical: true,
            hasFallback: false,
          },
        ],
      });

      expect(message).toContain("WebAssembly");
      expect(message).toContain("not available");
    });

    it("falls back to '<name> is not supported' when a critical check has no error text", () => {
      const message = getUnsupportedBrowserMessage({
        ...base,
        isFullySupported: false,
        unsupportedCritical: [
          { name: "BigInt", supported: false, critical: true, hasFallback: false },
        ],
      });

      expect(message).toContain("BigInt is not supported");
    });

    it("returns a warning message for non-critical failures", () => {
      const message = getUnsupportedBrowserMessage({
        ...base,
        isFullySupported: false,
        checks: [
          { name: "Web Workers", supported: false, critical: false, hasFallback: true },
          { name: "localStorage", supported: false, critical: false, hasFallback: true },
        ],
      });

      expect(message).toContain("features are not available");
      expect(message).toContain("Web Workers, localStorage");
      expect(message).toContain("reduced functionality");
    });
  });

  describe("requireBrowserCapabilities", () => {
    it("does not throw when basic support is available", () => {
      expect(() => requireBrowserCapabilities()).not.toThrow();
    });

    it("throws a descriptive error when basic support is missing", () => {
      vi.stubGlobal("WebAssembly", undefined);

      expect(() => requireBrowserCapabilities()).toThrow(/WebAssembly/);
    });

    it("does not throw when only non-critical features are missing", () => {
      vi.stubGlobal("Worker", undefined);
      vi.stubGlobal("SharedArrayBuffer", undefined);

      expect(() => requireBrowserCapabilities()).not.toThrow();
    });
  });
});
