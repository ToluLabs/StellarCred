import { describe, it, expect } from "vitest";
import { validateReturnUrl, resolveVerifyRedirect } from "../verify-redirect";

describe("verify-redirect-security (#978)", () => {
  const currentOrigin = "https://stellarcred.xyz";

  it("permits safe relative URLs and resolves to internal target", () => {
    const res = resolveVerifyRedirect({
      returnUrl: "/dashboard?tab=overview",
      address: "GAAA111",
      currentOrigin,
    });

    expect(res).not.toBeNull();
    if (res && "target" in res) {
      expect(res.target.kind).toBe("internal");
      expect(res.target.url).toContain("/dashboard?tab=overview");
      expect(res.target.url).toContain("sc_verified=true");
      expect(res.target.url).toContain("sc_wallet=GAAA111");
    } else {
      expect.fail("Expected target");
    }
  });

  it("permits safe external HTTPS URLs and resolves to external target", () => {
    const res = resolveVerifyRedirect({
      returnUrl: "https://integrator.org/callback",
      address: "GBBB222",
      justIssuedClaims: ["kyc", "age"],
      currentOrigin,
    });

    expect(res).not.toBeNull();
    if (res && "target" in res) {
      expect(res.target.kind).toBe("external");
      expect(res.target.url).toContain("https://integrator.org/callback");
      expect(res.target.url).toContain("sc_claims=kyc%2Cage");
    } else {
      expect.fail("Expected target");
    }
  });

  it("rejects protocol-relative URLs", () => {
    const result = validateReturnUrl("//attacker.com/steal", currentOrigin);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Protocol-relative URLs are not permitted/);

    const redirect = resolveVerifyRedirect({
      returnUrl: "//attacker.com/steal",
      address: "GAAA111",
      currentOrigin,
    });
    expect(redirect).toEqual({
      error: "Invalid return URL: Protocol-relative URLs are not permitted.",
    });
  });

  it("rejects backslash bypasses", () => {
    const result = validateReturnUrl("/\\attacker.com", currentOrigin);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Protocol-relative URLs are not permitted/);
  });

  it("rejects dangerous pseudo-schemes (javascript, data, vbscript)", () => {
    expect(validateReturnUrl("javascript:alert(1)", currentOrigin).ok).toBe(false);
    expect(validateReturnUrl("data:text/html,<script>alert(1)</script>", currentOrigin).ok).toBe(
      false,
    );
    expect(validateReturnUrl("vbscript:msgbox", currentOrigin).ok).toBe(false);
  });

  it("rejects external HTTP URLs", () => {
    const result = validateReturnUrl("http://insecure-site.com/callback", currentOrigin);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Must use HTTPS protocol/);
  });

  it("rejects URLs with embedded credentials (userinfo)", () => {
    const result = validateReturnUrl("https://user:pass@legit-site.com/callback", currentOrigin);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Credentials in URL are forbidden/);
  });

  it("rejects malformed URLs", () => {
    const result = validateReturnUrl("http://", currentOrigin);
    expect(result.ok).toBe(false);
  });
});
