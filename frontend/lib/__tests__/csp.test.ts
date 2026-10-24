import { describe, it, expect } from "vitest";
import {
  generateNonce,
  buildCsp,
  resolveCspMode,
  resolveBadgeFrameAncestors,
  CSP_REPORT_PATH,
  CSP_REPORT_GROUP,
} from "../csp.mjs";

const GOLDEN_CSP_WC_OFF_RPC_OFF =
  "default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://stellar.creit.tech https://storage.herewallet.app; connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org;";

const GOLDEN_CSP_WC_OFF_RPC_ON =
  "default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://stellar.creit.tech https://storage.herewallet.app; connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org https://custom-rpc.example.com;";

const GOLDEN_CSP_WC_ON_RPC_OFF =
  "default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://stellar.creit.tech https://storage.herewallet.app https://explorer-api.walletconnect.com; connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org wss://relay.walletconnect.com wss://relay.walletconnect.org https://explorer-api.walletconnect.com https://verify.walletconnect.com https://verify.walletconnect.org; frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org;";

const GOLDEN_CSP_WC_ON_RPC_ON =
  "default-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://stellar.creit.tech https://storage.herewallet.app https://explorer-api.walletconnect.com; connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org wss://relay.walletconnect.com wss://relay.walletconnect.org https://explorer-api.walletconnect.com https://verify.walletconnect.com https://verify.walletconnect.org https://custom-rpc.example.com; frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org;";

describe("CSP builder", () => {
  describe("baseline non-strict mode golden values", () => {
    it("matches golden value when WalletConnect is off and RPC is off", () => {
      const csp = buildCsp({ strict: false, walletConnectEnabled: false });
      expect(csp).toBe(GOLDEN_CSP_WC_OFF_RPC_OFF);
    });

    it("matches golden value when WalletConnect is off and RPC is on", () => {
      const csp = buildCsp({
        strict: false,
        walletConnectEnabled: false,
        rpcUrl: "https://custom-rpc.example.com",
      });
      expect(csp).toBe(GOLDEN_CSP_WC_OFF_RPC_ON);
    });

    it("matches golden value when WalletConnect is on and RPC is off", () => {
      const csp = buildCsp({ strict: false, walletConnectEnabled: true });
      expect(csp).toBe(GOLDEN_CSP_WC_ON_RPC_OFF);
    });

    it("matches golden value when WalletConnect is on and RPC is on", () => {
      const csp = buildCsp({
        strict: false,
        walletConnectEnabled: true,
        rpcUrl: "https://custom-rpc.example.com",
      });
      expect(csp).toBe(GOLDEN_CSP_WC_ON_RPC_ON);
    });
  });

  describe("strict mode", () => {
    it("script-src contains the nonce and not 'unsafe-inline'", () => {
      const nonce = "dGVzdC1ub25jZS12YWx1ZQ==";
      const csp = buildCsp({ strict: true, nonce });

      const scriptSrcDirective = csp
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("script-src "));

      expect(scriptSrcDirective).toBeDefined();
      expect(scriptSrcDirective).toContain(`'nonce-${nonce}'`);
      expect(scriptSrcDirective).not.toContain("'unsafe-inline'");
      expect(scriptSrcDirective).toContain("'self'");
      expect(scriptSrcDirective).toContain("'wasm-unsafe-eval'");

      // style-src must still keep 'unsafe-inline'
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    });

    it("strict mode adds frame-ancestors, worker-src and manifest-src; both modes share object-src, base-uri and form-action", () => {
      const strictDirectives = [
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "worker-src 'self'",
        "manifest-src 'self'",
      ];

      const sharedDirectives = ["object-src 'none'", "base-uri 'self'", "form-action 'self'"];

      const strictOnlyDirectives = [
        "frame-ancestors 'none'",
        "worker-src 'self'",
        "manifest-src 'self'",
      ];

      const strictCsp = buildCsp({ strict: true, nonce: "test-nonce" });
      for (const directive of strictDirectives) {
        expect(strictCsp).toContain(directive);
      }

      const nonStrictCsp = buildCsp({ strict: false });
      for (const directive of strictOnlyDirectives) {
        expect(nonStrictCsp).not.toContain(directive);
      }

      for (const directive of sharedDirectives) {
        expect(strictCsp).toContain(directive);
        expect(nonStrictCsp).toContain(directive);
      }
    });

    it("throws an error when strict is true and nonce is falsy", () => {
      expect(() => buildCsp({ strict: true })).toThrow("buildCsp: strict mode requires a nonce");
      expect(() => buildCsp({ strict: true, nonce: "" })).toThrow(
        "buildCsp: strict mode requires a nonce",
      );
    });
  });

  describe("WalletConnect gating", () => {
    const wcEntries = [
      "https://explorer-api.walletconnect.com",
      "wss://relay.walletconnect.com",
      "wss://relay.walletconnect.org",
      "https://verify.walletconnect.com",
      "https://verify.walletconnect.org",
      "frame-src",
    ];

    it("WalletConnect-only entries appear only when enabled (strict: false)", () => {
      const disabledCsp = buildCsp({
        strict: false,
        walletConnectEnabled: false,
      });
      for (const entry of wcEntries) {
        expect(disabledCsp).not.toContain(entry);
      }

      const enabledCsp = buildCsp({
        strict: false,
        walletConnectEnabled: true,
      });
      for (const entry of wcEntries) {
        expect(enabledCsp).toContain(entry);
      }
    });

    it("WalletConnect-only entries appear only when enabled (strict: true)", () => {
      const disabledCsp = buildCsp({
        strict: true,
        walletConnectEnabled: false,
        nonce: "abc",
      });
      for (const entry of wcEntries) {
        expect(disabledCsp).not.toContain(entry);
      }

      const enabledCsp = buildCsp({
        strict: true,
        walletConnectEnabled: true,
        nonce: "abc",
      });
      for (const entry of wcEntries) {
        expect(enabledCsp).toContain(entry);
      }
    });
  });

  describe("rpcUrl handling", () => {
    it("rpcUrl is appended to connect-src when provided", () => {
      const customRpc = "https://custom-soroban.example.com";
      const withRpc = buildCsp({ strict: true, nonce: "abc", rpcUrl: customRpc });
      expect(withRpc).toContain(
        `connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org ${customRpc}`,
      );

      const withoutRpc = buildCsp({ strict: true, nonce: "abc" });
      expect(withoutRpc).toContain(
        "connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org;",
      );
      expect(withoutRpc).not.toContain(customRpc);
    });
  });

  describe("indexerUrl handling", () => {
    it("indexerUrl is appended to connect-src when provided", () => {
      const customIndexer = "https://indexer.example.com";
      const withIndexer = buildCsp({
        strict: true,
        nonce: "abc",
        indexerUrl: customIndexer,
      });
      expect(withIndexer).toContain(
        `connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org ${customIndexer}`,
      );

      const withoutIndexer = buildCsp({ strict: true, nonce: "abc" });
      expect(withoutIndexer).not.toContain(customIndexer);
    });

    it("appends both rpcUrl and indexerUrl when both are provided", () => {
      const customRpc = "https://custom-rpc.example.com";
      const customIndexer = "https://indexer.example.com";
      const withBoth = buildCsp({
        strict: true,
        nonce: "abc",
        rpcUrl: customRpc,
        indexerUrl: customIndexer,
      });
      expect(withBoth).toContain(
        `connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org ${customRpc} ${customIndexer}`,
      );
    });

    it("supports indexerUrl in baseline non-strict mode", () => {
      const customIndexer = "https://indexer.example.com";
      const csp = buildCsp({
        strict: false,
        indexerUrl: customIndexer,
      });
      expect(csp).toContain(
        `connect-src 'self' https://soroban-testnet.stellar.org https://soroban-mainnet.stellar.org ${customIndexer}`,
      );
    });
  });

  describe("frameAncestors handling", () => {
    it("uses custom frameAncestors in strict mode when provided", () => {
      const csp = buildCsp({
        strict: true,
        nonce: "abc",
        frameAncestors: "*",
      });
      expect(csp).toContain("frame-ancestors *");
      expect(csp).not.toContain("frame-ancestors 'none'");
    });

    it("uses custom frameAncestors in non-strict mode when provided", () => {
      const csp = buildCsp({
        strict: false,
        frameAncestors: "https://partner.example.com",
      });
      expect(csp).toContain("frame-ancestors https://partner.example.com");
    });

    it("defaults to 'none' in strict mode when frameAncestors is omitted", () => {
      const csp = buildCsp({ strict: true, nonce: "abc" });
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("resolves badge frame ancestors properly with resolveBadgeFrameAncestors", () => {
      expect(resolveBadgeFrameAncestors(undefined)).toBe("*");
      expect(resolveBadgeFrameAncestors("")).toBe("*");
      expect(resolveBadgeFrameAncestors("   ")).toBe("*");
      expect(resolveBadgeFrameAncestors("https://app.example.com")).toBe("https://app.example.com");
      expect(resolveBadgeFrameAncestors("https://app.example.com, https://partner.org")).toBe(
        "https://app.example.com https://partner.org",
      );
    });
  });

  describe("generateNonce", () => {
    it("returns different values on successive calls and is valid base64 of at least 16 bytes", () => {
      const nonces = Array.from({ length: 20 }, () => generateNonce());
      const uniqueNonces = new Set(nonces);
      expect(uniqueNonces.size).toBe(nonces.length);

      const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
      for (const nonce of nonces) {
        expect(nonce).toMatch(base64Regex);
        const decoded = atob(nonce);
        expect(decoded.length).toBeGreaterThanOrEqual(16);
      }
    });
  });

  describe("report directives", () => {
    it("appear only when reportEndpoint is passed", () => {
      const endpoint = "https://stellarcred.report-uri.com/r/d/csp/enforce";

      const withoutReportStrict = buildCsp({ strict: true, nonce: "abc" });
      expect(withoutReportStrict).not.toContain("report-uri");
      expect(withoutReportStrict).not.toContain("report-to");

      const withoutReportNonStrict = buildCsp({ strict: false });
      expect(withoutReportNonStrict).not.toContain("report-uri");
      expect(withoutReportNonStrict).not.toContain("report-to");

      const withReportStrict = buildCsp({
        strict: true,
        nonce: "abc",
        reportEndpoint: endpoint,
      });
      expect(withReportStrict).toContain(`report-uri ${endpoint}`);
      expect(withReportStrict).toContain("report-to csp-endpoint");

      const withReportNonStrict = buildCsp({
        strict: false,
        reportEndpoint: endpoint,
      });
      expect(withReportNonStrict).toContain(`report-uri ${endpoint}`);
      expect(withReportNonStrict).toContain("report-to csp-endpoint");
    });

    it("exports CSP_REPORT_PATH and CSP_REPORT_GROUP constants", () => {
      expect(CSP_REPORT_PATH).toBe("/api/csp-report");
      expect(CSP_REPORT_GROUP).toBe("csp-endpoint");
    });
  });

  describe("resolveCspMode", () => {
    it("returns 'enforce' for enforce and case-insensitive/trimmed variations", () => {
      expect(resolveCspMode("enforce")).toBe("enforce");
      expect(resolveCspMode(" ENFORCE ")).toBe("enforce");
    });

    it("fails safe to 'report-only' for everything else", () => {
      expect(resolveCspMode("report-only")).toBe("report-only");
      expect(resolveCspMode("")).toBe("report-only");
      expect(resolveCspMode(undefined)).toBe("report-only");
      expect(resolveCspMode("yes")).toBe("report-only");
      expect(resolveCspMode("enforced")).toBe("report-only");
    });
  });
});
