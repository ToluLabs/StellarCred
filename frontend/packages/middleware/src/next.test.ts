import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const hasClaimsMock = vi.fn();
const buildVerifyUrlMock = vi.fn();

vi.mock("@stellarcred/sdk", () => ({
  hasClaims: (...args: unknown[]) => hasClaimsMock(...args),
  buildVerifyUrl: (...args: unknown[]) => buildVerifyUrlMock(...args),
}));

import { createStellarCredMiddleware, withStellarCredGate } from "./next";

beforeEach(() => {
  hasClaimsMock.mockReset();
  buildVerifyUrlMock.mockReset();
});

function req(url = "https://app.example/vault") {
  return new NextRequest(url);
}

describe("createStellarCredMiddleware", () => {
  it("passes the request through when every claim is present", async () => {
    hasClaimsMock.mockResolvedValue({ kyc: true });
    const middleware = createStellarCredMiddleware({ claims: ["kyc"], getWallet: () => "GWALLET" });
    const res = await middleware(req());
    // NextResponse.next() carries this internal marker header.
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("returns 403 JSON when a claim is missing", async () => {
    hasClaimsMock.mockResolvedValue({ kyc: false });
    const middleware = createStellarCredMiddleware({ claims: ["kyc"], getWallet: () => "GWALLET" });
    const res = await middleware(req());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "insufficient_claims", required: ["kyc"], missing: ["kyc"] });
  });

  it("redirects to the verify flow when onFail is 'redirect'", async () => {
    hasClaimsMock.mockResolvedValue({ kyc: false });
    buildVerifyUrlMock.mockReturnValue("https://stellarcred.xyz/verify?claim=kyc");
    const middleware = createStellarCredMiddleware({
      claims: ["kyc"],
      getWallet: () => "GWALLET",
      onFail: "redirect",
      returnUrl: "/vault",
    });
    const res = await middleware(req());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://stellarcred.xyz/verify?claim=kyc");
  });

  it("treats a missing wallet as failing every requested claim without calling hasClaims", async () => {
    const middleware = createStellarCredMiddleware({ claims: ["kyc", "age"], getWallet: () => null });
    const res = await middleware(req());
    expect(hasClaimsMock).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.missing).toEqual(["kyc", "age"]);
  });
});

describe("withStellarCredGate", () => {
  it("invokes the handler with the resolved wallet when the gate passes", async () => {
    hasClaimsMock.mockResolvedValue({ kyc: true, funds: true });
    const handler = vi.fn(async (_req: NextRequest, ctx: { wallet: string }) =>
      Response.json({ wallet: ctx.wallet }),
    );
    const route = withStellarCredGate(
      { claims: ["kyc", "funds"], minThresholds: { funds: 50000 }, getWallet: () => "GWALLET" },
      handler,
    );
    const res = await route(req());
    expect(handler).toHaveBeenCalledWith(expect.anything(), { wallet: "GWALLET" });
    expect(await res.json()).toEqual({ wallet: "GWALLET" });
  });

  it("short-circuits with a 403 without invoking the handler", async () => {
    hasClaimsMock.mockResolvedValue({ kyc: false });
    const handler = vi.fn();
    const route = withStellarCredGate({ claims: ["kyc"], getWallet: () => "GWALLET" }, handler);
    const res = await route(req());
    expect(handler).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });
});
