import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useVerifyParams } from "../hooks/useVerifyParams";
import * as verifyNonce from "../verify-nonce";

let currentParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentParams,
}));

describe("useVerifyParams hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts protocol parameters and sets locked state when claim is valid", () => {
    currentParams = new URLSearchParams({
      return_url: "https://partner.xyz/callback",
      claim: "age",
      threshold_years: "21",
    });

    const { result } = renderHook(() => useVerifyParams());

    expect(result.current.locked).toBe(true);
    expect(result.current.requiredClaim).toBe("age");
    expect(result.current.returnUrl).toBe("https://partner.xyz/callback");
    expect(result.current.claimParamsFromUrl.threshold_years).toBe("21");
    expect(result.current.linkError).toBeNull();
  });

  it("sets linkError if nonce is already consumed", () => {
    currentParams = new URLSearchParams({
      return_url: "https://partner.xyz/callback",
      claim: "kyc",
      jti: "consumed-nonce",
      exp: "1800000000",
    });

    vi.spyOn(verifyNonce, "isVerifyNonceConsumed").mockReturnValue(true);

    const { result } = renderHook(() => useVerifyParams());

    expect(result.current.linkError).toEqual({
      code: "consumed_link",
      title: "This verification link has already been used",
      detail:
        "Each single-use verification link can only be opened once. Ask the service that sent you here for a fresh link.",
    });
  });

  it("surfaces linkError for malformed or missing return_url", () => {
    currentParams = new URLSearchParams({
      claim: "kyc", // missing return_url
    });

    const { result } = renderHook(() => useVerifyParams());

    expect(result.current.linkError).not.toBeNull();
    expect(result.current.linkError?.code).toBe("missing_return_url");
  });
});
