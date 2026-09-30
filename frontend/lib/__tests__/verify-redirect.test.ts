import { describe, it, expect, vi } from "vitest";
import {
  resolveVerifyRedirect,
  performVerifyRedirect,
} from "../verify-redirect";
import * as verifyNonce from "../verify-nonce";

describe("verify-redirect", () => {
  const currentOrigin = "https://stellarcred.xyz";
  const address = "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ";

  describe("resolveVerifyRedirect", () => {
    it("returns null if returnUrl is missing", () => {
      const res = resolveVerifyRedirect({
        returnUrl: null,
        address,
        currentOrigin,
      });
      expect(res).toBeNull();
    });

    it("returns null if address is missing", () => {
      const res = resolveVerifyRedirect({
        returnUrl: "/holder",
        address: null,
        currentOrigin,
      });
      expect(res).toBeNull();
    });

    it("resolves same-origin relative path as internal navigation", () => {
      const res = resolveVerifyRedirect({
        returnUrl: "/apps/lendfi?session=123",
        address,
        justIssuedClaims: ["kyc", "age"],
        currentOrigin,
      });

      expect(res).toEqual({
        target: {
          kind: "internal",
          url: "/apps/lendfi?session=123&sc_verified=true&sc_wallet=" + address + "&sc_claims=kyc%2Cage",
        },
      });
    });

    it("resolves same-origin absolute URL as internal navigation", () => {
      const res = resolveVerifyRedirect({
        returnUrl: "https://stellarcred.xyz/dashboard",
        address,
        justIssuedClaims: ["funds"],
        currentOrigin,
      });

      expect(res).toEqual({
        target: {
          kind: "internal",
          url: "/dashboard?sc_verified=true&sc_wallet=" + address + "&sc_claims=funds",
        },
      });
    });

    it("resolves valid external HTTPS URL as external navigation", () => {
      const res = resolveVerifyRedirect({
        returnUrl: "https://protocol.finance/verify-callback?step=done",
        address,
        justIssuedClaims: ["income"],
        currentOrigin,
      });

      expect(res).toEqual({
        target: {
          kind: "external",
          url: "https://protocol.finance/verify-callback?step=done&sc_verified=true&sc_wallet=" + address + "&sc_claims=income",
        },
      });
    });

    it("rejects insecure external HTTP URL with HTTPS requirement error", () => {
      const res = resolveVerifyRedirect({
        returnUrl: "http://protocol.finance/insecure-callback",
        address,
        currentOrigin,
      });

      expect(res).toEqual({
        error: "Invalid return URL: Must use HTTPS protocol.",
      });
    });

    it("rejects malformed return URL", () => {
      const res = resolveVerifyRedirect({
        returnUrl: "http://[invalid-url",
        address,
        currentOrigin,
      });

      expect(res).toEqual({
        error: "Invalid return URL: Must be a well-formed URL.",
      });
    });
  });

  describe("performVerifyRedirect", () => {
    it("consumes nonce when parsedLink contains a jti", () => {
      const consumeSpy = vi.spyOn(verifyNonce, "consumeVerifyNonce").mockImplementation(() => true);
      const routerPush = vi.fn();
      const setHref = vi.fn();

      performVerifyRedirect({
        returnUrl: "/holder",
        address,
        parsedLink: { ok: true, jti: "nonce-12345", exp: 1700000000 },
        currentOrigin,
        router: { push: routerPush },
        navigation: { setHref },
      });

      expect(consumeSpy).toHaveBeenCalledWith("nonce-12345", 1700000000);
      consumeSpy.mockRestore();
    });

    it("delegates internal navigation to router.push", () => {
      const routerPush = vi.fn();
      const setHref = vi.fn();

      performVerifyRedirect({
        returnUrl: "/apps/defi",
        address,
        justIssuedClaims: ["kyc"],
        currentOrigin,
        router: { push: routerPush },
        navigation: { setHref },
      });

      expect(routerPush).toHaveBeenCalledWith("/apps/defi?sc_verified=true&sc_wallet=" + address + "&sc_claims=kyc");
      expect(setHref).not.toHaveBeenCalled();
    });

    it("strictly uses navigation.setHref for external URLs and NEVER router.push", () => {
      const routerPush = vi.fn();
      const setHref = vi.fn();

      performVerifyRedirect({
        returnUrl: "https://external-app.io/auth",
        address,
        justIssuedClaims: ["accreditation"],
        currentOrigin,
        router: { push: routerPush },
        navigation: { setHref },
      });

      expect(setHref).toHaveBeenCalledWith("https://external-app.io/auth?sc_verified=true&sc_wallet=" + address + "&sc_claims=accreditation");
      expect(routerPush).not.toHaveBeenCalled();
    });

    it("surfaces error and falls back to /holder on invalid protocol", () => {
      const routerPush = vi.fn();
      const setHref = vi.fn();
      const onSetUrlError = vi.fn();

      performVerifyRedirect({
        returnUrl: "http://insecure.io/callback",
        address,
        currentOrigin,
        onSetUrlError,
        router: { push: routerPush },
        navigation: { setHref },
      });

      expect(onSetUrlError).toHaveBeenCalledWith("Invalid return URL: Must use HTTPS protocol.");
      expect(routerPush).toHaveBeenCalledWith("/holder");
      expect(setHref).not.toHaveBeenCalled();
    });

    it("falls back to /holder when no returnUrl is provided", () => {
      const routerPush = vi.fn();
      const setHref = vi.fn();

      performVerifyRedirect({
        returnUrl: null,
        address,
        currentOrigin,
        router: { push: routerPush },
        navigation: { setHref },
      });

      expect(routerPush).toHaveBeenCalledWith("/holder");
      expect(setHref).not.toHaveBeenCalled();
    });
  });
});
