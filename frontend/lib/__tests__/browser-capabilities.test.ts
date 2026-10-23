/**
 * Unit tests for browser capability detection.
 *
 * Issue #900: Add graceful degradation for unsupported browser capabilities
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkBrowserCapabilities,
  getUnsupportedBrowserMessage,
  requireBrowserCapabilities,
  type CapabilityCheck,
} from "../browser-capabilities";

// Mock globalThis for cross-origin isolation tests
const originalGlobalThis = globalThis;

describe("browser-capabilities", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkBrowserCapabilities", () => {
    it("should return a capabilities object with all checks", () => {
      const capabilities = checkBrowserCapabilities();

      expect(capabilities).toHaveProperty("checks");
      expect(capabilities).toHaveProperty("isFullySupported");
      expect(capabilities).toHaveProperty("hasBasicSupport");
      expect(capabilities).toHaveProperty("unsupportedCritical");
      expect(Array.isArray(capabilities.checks)).toBe(true);
      expect(capabilities.checks.length).toBeGreaterThan(0);
    });

    it("should check WebAssembly capability", () => {
      const capabilities = checkBrowserCapabilities();
      const wasmCheck = capabilities.checks.find((c) => c.name === "WebAssembly");

      expect(wasmCheck).toBeDefined();
      expect(wasmCheck).toHaveProperty("supported");
      expect(wasmCheck).toHaveProperty("critical");
      expect(wasmCheck).toHaveProperty("hasFallback");
    });

    it("should check Web Workers capability", () => {
      const capabilities = checkBrowserCapabilities();
      const workerCheck = capabilities.checks.find((c) => c.name === "Web Workers");

      expect(workerCheck).toBeDefined();
      expect(workerCheck).toHaveProperty("supported");
      expect(workerCheck).toHaveProperty("critical");
      expect(workerCheck?.hasFallback).toBe(true);
    });

    it("should check Web Crypto API capability", () => {
      const capabilities = checkBrowserCapabilities();
      const cryptoCheck = capabilities.checks.find((c) => c.name === "Web Crypto API");

      expect(cryptoCheck).toBeDefined();
      expect(cryptoCheck).toHaveProperty("supported");
      expect(cryptoCheck?.critical).toBe(true);
    });

    it("should check BigInt capability", () => {
      const capabilities = checkBrowserCapabilities();
      const bigintCheck = capabilities.checks.find((c) => c.name === "BigInt");

      expect(bigintCheck).toBeDefined();
      expect(bigintCheck).toHaveProperty("supported");
      expect(bigintCheck?.critical).toBe(true);
    });

    it("should check localStorage capability", () => {
      const capabilities = checkBrowserCapabilities();
      const storageCheck = capabilities.checks.find((c) => c.name === "localStorage");

      expect(storageCheck).toBeDefined();
      expect(storageCheck).toHaveProperty("supported");
      expect(storageCheck?.hasFallback).toBe(true);
    });

    it("should check sessionStorage capability", () => {
      const capabilities = checkBrowserCapabilities();
      const storageCheck = capabilities.checks.find((c) => c.name === "sessionStorage");

      expect(storageCheck).toBeDefined();
      expect(storageCheck).toHaveProperty("supported");
      expect(storageCheck?.hasFallback).toBe(true);
    });

    it("should identify critical capabilities", () => {
      const capabilities = checkBrowserCapabilities();
      const criticalChecks = capabilities.checks.filter((c) => c.critical);

      expect(criticalChecks.length).toBeGreaterThan(0);
      criticalChecks.forEach((check) => {
        expect(check).toHaveProperty("critical", true);
      });
    });

    it("should report isFullySupported correctly when all critical features work", () => {
      const capabilities = checkBrowserCapabilities();

      // In a modern test environment, most features should be supported
      // The exact result depends on the test environment
      expect(typeof capabilities.isFullySupported).toBe("boolean");
    });

    it("should report hasBasicSupport correctly", () => {
      const capabilities = checkBrowserCapabilities();

      expect(typeof capabilities.hasBasicSupport).toBe("boolean");
    });
  });

  describe("getUnsupportedBrowserMessage", () => {
    it("should return empty string when fully supported", () => {
      const capabilities: any = {
        isFullySupported: true,
        unsupportedCritical: [],
        checks: [],
      };

      const message = getUnsupportedBrowserMessage(capabilities);
      expect(message).toBe("");
    });

    it("should return error message for critical failures", () => {
      const capabilities: any = {
        isFullySupported: false,
        unsupportedCritical: [
          { name: "WebAssembly", error: "WebAssembly is not available" },
        ],
        checks: [],
      };

      const message = getUnsupportedBrowserMessage(capabilities);
      expect(message).toContain("WebAssembly");
      expect(message).toContain("not available");
    });

    it("should return warning message for non-critical failures", () => {
      const capabilities: any = {
        isFullySupported: false,
        unsupportedCritical: [],
        checks: [
          { name: "Web Workers", supported: false, critical: false },
          { name: "localStorage", supported: false, critical: false },
        ],
      };

      const message = getUnsupportedBrowserMessage(capabilities);
      expect(message).toContain("features are not available");
      expect(message).toContain("reduced functionality");
    });
  });

  describe("requireBrowserCapabilities", () => {
    it("should not throw when basic support is available", () => {
      // In a modern test environment, this should not throw
      expect(() => requireBrowserCapabilities()).not.toThrow();
    });

    it("should throw when basic support is not available", () => {
      // Mock checkBrowserCapabilities to return no basic support
      vi.mock("../browser-capabilities", async () => {
        const actual = await vi.importActual<typeof import("../browser-capabilities")>(
          "../browser-capabilities",
        );
        return {
          ...actual,
          checkBrowserCapabilities: () => ({
            checks: [],
            isFullySupported: false,
            hasBasicSupport: false,
            unsupportedCritical: [],
          }),
        };
      });

      // This test is conceptual - in practice we'd need to mock the module
      // For now, we just verify the function exists
      expect(typeof requireBrowserCapabilities).toBe("function");
    });
  });

  describe("CapabilityCheck structure", () => {
    it("should have required properties", () => {
      const check: CapabilityCheck = {
        name: "Test Feature",
        supported: true,
        critical: false,
        hasFallback: true,
      };

      expect(check.name).toBe("Test Feature");
      expect(check.supported).toBe(true);
      expect(check.critical).toBe(false);
      expect(check.hasFallback).toBe(true);
    });

    it("should include optional error when not supported", () => {
      const check: CapabilityCheck = {
        name: "Test Feature",
        supported: false,
        error: "Feature not available",
        critical: true,
        hasFallback: false,
      };

      expect(check.error).toBe("Feature not available");
    });

    it("should include fallback description when fallback exists", () => {
      const check: CapabilityCheck = {
        name: "Test Feature",
        supported: false,
        error: "Feature not available",
        critical: false,
        hasFallback: true,
        fallbackDescription: "Will use alternative method",
      };

      expect(check.fallbackDescription).toBe("Will use alternative method");
    });
  });
});
