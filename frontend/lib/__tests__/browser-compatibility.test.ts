import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isCryptoSupported,
  isSubtleCryptoSupported,
  isWebAssemblySupported,
  isWebWorkerSupported,
  isStorageSupported,
  isSecureContextSupported,
  isWalletExtensionDetected,
  isWebUsbSupported,
  detectBrowserCapabilities,
} from "../browser-compatibility";

describe("browser-compatibility capability detection", () => {
  describe("individual capability checks with overrides", () => {
    it("detects crypto support correctly", () => {
      expect(isCryptoSupported({ crypto: { getRandomValues: vi.fn() } })).toBe(true);
      expect(isCryptoSupported({ crypto: {} })).toBe(false);
      expect(isCryptoSupported({ crypto: undefined })).toBe(false);
    });

    it("detects subtle crypto support correctly", () => {
      expect(isSubtleCryptoSupported({ subtleCrypto: true })).toBe(true);
      expect(isSubtleCryptoSupported({ crypto: { subtle: {} } })).toBe(true);
      expect(isSubtleCryptoSupported({ crypto: { subtle: undefined } })).toBe(false);
      expect(isSubtleCryptoSupported({ subtleCrypto: false })).toBe(false);
    });

    it("detects WebAssembly support correctly", () => {
      expect(isWebAssemblySupported({ webAssembly: { instantiate: vi.fn() } })).toBe(true);
      expect(isWebAssemblySupported({ webAssembly: {} })).toBe(false);
      expect(isWebAssemblySupported({ webAssembly: undefined })).toBe(false);
    });

    it("detects Web Worker support correctly", () => {
      expect(isWebWorkerSupported({ worker: true })).toBe(true);
      expect(isWebWorkerSupported({ worker: false })).toBe(false);
    });

    it("detects storage support correctly", () => {
      expect(isStorageSupported({ storage: true })).toBe(true);
      expect(isStorageSupported({ storage: false })).toBe(false);
    });

    it("detects secure context correctly", () => {
      expect(isSecureContextSupported({ isSecureContext: true })).toBe(true);
      expect(isSecureContextSupported({ isSecureContext: false })).toBe(false);
      expect(isSecureContextSupported({ protocol: "https:", hostname: "stellarcred.xyz" })).toBe(
        true,
      );
      expect(isSecureContextSupported({ protocol: "http:", hostname: "localhost" })).toBe(true);
      expect(isSecureContextSupported({ protocol: "http:", hostname: "127.0.0.1" })).toBe(true);
      expect(isSecureContextSupported({ protocol: "http:", hostname: "example.com" })).toBe(false);
    });

    it("detects wallet extensions correctly", () => {
      expect(isWalletExtensionDetected({ walletDetected: true })).toBe(true);
      expect(isWalletExtensionDetected({ walletDetected: false })).toBe(false);
    });

    it("detects WebUSB correctly", () => {
      expect(isWebUsbSupported({ webUsb: true })).toBe(true);
      expect(isWebUsbSupported({ webUsb: false })).toBe(false);
    });
  });

  describe("detectBrowserCapabilities full report", () => {
    it("reports fully compatible when all standard capabilities are present", () => {
      const report = detectBrowserCapabilities({
        crypto: { getRandomValues: vi.fn(), subtle: {} },
        webAssembly: { instantiate: vi.fn() },
        worker: true,
        storage: true,
        isSecureContext: true,
        walletDetected: true,
        webUsb: true,
      });

      expect(report.isCompatible).toBe(true);
      expect(report.hasBlockingIssues).toBe(false);
      expect(report.hasDegradedIssues).toBe(false);
      expect(report.issues).toHaveLength(0);
      expect(report.summary).toMatch(/All required browser capabilities are supported/);
    });

    it("flags missing WebAssembly as a blocking issue with actionable guidance and preview mode", () => {
      const report = detectBrowserCapabilities({
        crypto: { getRandomValues: vi.fn(), subtle: {} },
        webAssembly: undefined,
        worker: true,
        storage: true,
        isSecureContext: true,
      });

      expect(report.isCompatible).toBe(false);
      expect(report.hasBlockingIssues).toBe(true);
      const wasmIssue = report.issues.find((i) => i.id === "webAssembly");
      expect(wasmIssue).toBeDefined();
      expect(wasmIssue?.severity).toBe("error");
      expect(wasmIssue?.title).toBe("WebAssembly not supported");
      expect(wasmIssue?.impact).toMatch(/ZK proof/i);
      expect(wasmIssue?.actionableSteps.length).toBeGreaterThan(0);
      expect(wasmIssue?.fallbackAvailable).toBe(true);
      expect(wasmIssue?.actions?.some((a) => a.type === "preview-mode")).toBe(true);
    });

    it("flags missing WebCrypto as a blocking issue", () => {
      const report = detectBrowserCapabilities({
        crypto: undefined,
        webAssembly: { instantiate: vi.fn() },
        worker: true,
        storage: true,
        isSecureContext: true,
      });

      expect(report.isCompatible).toBe(false);
      expect(report.hasBlockingIssues).toBe(true);
      const cryptoIssue = report.issues.find((i) => i.id === "crypto");
      expect(cryptoIssue).toBeDefined();
      expect(cryptoIssue?.severity).toBe("error");
      expect(cryptoIssue?.title).toMatch(/Cryptographic features unavailable/);
      expect(cryptoIssue?.actionableSteps.some((s) => s.includes("modern"))).toBe(true);
      expect(cryptoIssue?.fallbackAvailable).toBe(true);
    });

    it("flags missing SubtleCrypto as a degraded warning", () => {
      const report = detectBrowserCapabilities({
        crypto: { getRandomValues: vi.fn(), subtle: undefined },
        webAssembly: { instantiate: vi.fn() },
        worker: true,
        storage: true,
        isSecureContext: true,
      });

      expect(report.isCompatible).toBe(false);
      expect(report.hasBlockingIssues).toBe(false);
      expect(report.hasDegradedIssues).toBe(true);
      const subtleIssue = report.issues.find((i) => i.id === "subtleCrypto");
      expect(subtleIssue).toBeDefined();
      expect(subtleIssue?.severity).toBe("warning");
    });

    it("flags unencrypted HTTP context as a warning with actionable instructions", () => {
      const report = detectBrowserCapabilities({
        crypto: { getRandomValues: vi.fn(), subtle: {} },
        webAssembly: { instantiate: vi.fn() },
        worker: true,
        storage: true,
        isSecureContext: false,
      });

      expect(report.isCompatible).toBe(false);
      expect(report.hasDegradedIssues).toBe(true);
      const secureIssue = report.issues.find((i) => i.id === "secureContext");
      expect(secureIssue).toBeDefined();
      expect(secureIssue?.severity).toBe("warning");
      expect(secureIssue?.actionableSteps.some((s) => s.includes("HTTPS"))).toBe(true);
    });

    it("flags blocked storage as a degraded warning explaining private browsing", () => {
      const report = detectBrowserCapabilities({
        crypto: { getRandomValues: vi.fn(), subtle: {} },
        webAssembly: { instantiate: vi.fn() },
        worker: true,
        storage: false,
        isSecureContext: true,
      });

      expect(report.isCompatible).toBe(false);
      expect(report.hasDegradedIssues).toBe(true);
      const storageIssue = report.issues.find((i) => i.id === "storage");
      expect(storageIssue).toBeDefined();
      expect(storageIssue?.title).toMatch(/Private Mode/);
      expect(storageIssue?.actionableSteps.some((s) => s.includes("Export"))).toBe(true);
      expect(storageIssue?.fallbackModeDescription).toMatch(/In-Memory/);
    });

    it("flags missing Web Workers as an informational issue noting inline main-thread proving", () => {
      const report = detectBrowserCapabilities({
        crypto: { getRandomValues: vi.fn(), subtle: {} },
        webAssembly: { instantiate: vi.fn() },
        worker: false,
        storage: true,
        isSecureContext: true,
      });

      expect(report.hasBlockingIssues).toBe(false);
      const workerIssue = report.issues.find((i) => i.id === "webWorker");
      expect(workerIssue).toBeDefined();
      expect(workerIssue?.severity).toBe("info");
      expect(workerIssue?.fallbackModeDescription).toMatch(/Main-Thread/);
    });

    it("aggregates multiple missing capabilities without crashing", () => {
      const report = detectBrowserCapabilities({
        crypto: undefined,
        webAssembly: undefined,
        worker: false,
        storage: false,
        isSecureContext: false,
      });

      expect(report.isCompatible).toBe(false);
      expect(report.hasBlockingIssues).toBe(true);
      expect(report.hasDegradedIssues).toBe(true);
      expect(report.issues.length).toBeGreaterThanOrEqual(4);
      expect(report.summary).toMatch(/Critical browser capabilities missing/);
    });
  });
});
