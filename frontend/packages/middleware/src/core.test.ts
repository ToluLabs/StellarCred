import { describe, expect, it, vi, beforeEach } from "vitest";

const hasClaimsMock = vi.fn();
const buildVerifyUrlMock = vi.fn();

vi.mock("@stellarcred/sdk", () => ({
  hasClaims: (...args: unknown[]) => hasClaimsMock(...args),
  buildVerifyUrl: (...args: unknown[]) => buildVerifyUrlMock(...args),
}));

import {
  evaluateClaimGate,
  buildGateRedirectUrl,
  buildGateFailureBody,
  assertNonEmptyClaims,
} from "./core";

beforeEach(() => {
  hasClaimsMock.mockReset();
  buildVerifyUrlMock.mockReset();
});

describe("evaluateClaimGate", () => {
  it("passes when every requested claim is true", async () => {
    hasClaimsMock.mockResolvedValue({ kyc: true, funds: true });
    const result = await evaluateClaimGate("GWALLET", { claims: ["kyc", "funds"] });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(hasClaimsMock).toHaveBeenCalledWith("GWALLET", ["kyc", "funds"], {
      minThresholds: undefined,
      trustedIssuers: undefined,
      requestTimeoutMs: undefined,
    });
  });

  it("reports missing claims when some are false or absent", async () => {
    hasClaimsMock.mockResolvedValue({ kyc: true, funds: false });
    const result = await evaluateClaimGate("GWALLET", { claims: ["kyc", "funds"] });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["funds"]);
  });

  it("forwards minThresholds and trustedIssuers to hasClaims", async () => {
    hasClaimsMock.mockResolvedValue({ age: true });
    await evaluateClaimGate("GWALLET", {
      claims: ["age"],
      minThresholds: { age: 21 },
      trustedIssuers: ["GISSUER"],
      requestTimeoutMs: 5000,
    });
    expect(hasClaimsMock).toHaveBeenCalledWith("GWALLET", ["age"], {
      minThresholds: { age: 21 },
      trustedIssuers: ["GISSUER"],
      requestTimeoutMs: 5000,
    });
  });
});

describe("buildGateRedirectUrl", () => {
  it("builds a verify URL for the first missing claim", () => {
    buildVerifyUrlMock.mockReturnValue("https://stellarcred.xyz/verify?claim=kyc");
    const url = buildGateRedirectUrl(["kyc", "funds"], { returnUrl: "/vault" });
    expect(buildVerifyUrlMock).toHaveBeenCalledWith({
      returnUrl: "/vault",
      claim: "kyc",
      baseUrl: undefined,
    });
    expect(url).toBe("https://stellarcred.xyz/verify?claim=kyc");
  });

  it("throws when returnUrl is missing", () => {
    expect(() => buildGateRedirectUrl(["kyc"], {})).toThrow(/returnUrl/);
  });
});

describe("buildGateFailureBody", () => {
  it("shapes the 403 body", () => {
    expect(buildGateFailureBody(["kyc", "funds"], ["funds"])).toEqual({
      error: "insufficient_claims",
      required: ["kyc", "funds"],
      missing: ["funds"],
    });
  });
});

describe("assertNonEmptyClaims", () => {
  it("throws for an empty claims list", () => {
    expect(() => assertNonEmptyClaims([])).toThrow(/at least one claim/);
  });

  it("does not throw otherwise", () => {
    expect(() => assertNonEmptyClaims(["kyc"])).not.toThrow();
  });
});
