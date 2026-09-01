import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const hasClaimsMock = vi.fn();
const buildVerifyUrlMock = vi.fn();

vi.mock("@stellarcred/sdk", () => ({
  hasClaims: (...args: unknown[]) => hasClaimsMock(...args),
  buildVerifyUrl: (...args: unknown[]) => buildVerifyUrlMock(...args),
}));

import { stellarCredGate } from "./express";

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown; redirectedTo?: string } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res as Response;
  }) as unknown as Response["json"];
  res.redirect = vi.fn((..._args: unknown[]) => {
    const args = _args as [number, string] | [string];
    res.redirectedTo = args.length === 2 ? args[1] : (args[0] as string);
    return res as Response;
  }) as unknown as Response["redirect"];
  return res as Response & { statusCode?: number; body?: unknown; redirectedTo?: string };
}

beforeEach(() => {
  hasClaimsMock.mockReset();
  buildVerifyUrlMock.mockReset();
});

describe("stellarCredGate", () => {
  it("calls next() and attaches req.stellarcred when every claim passes", async () => {
    hasClaimsMock.mockResolvedValue({ kyc: true });
    const gate = stellarCredGate({ claims: ["kyc"], getWallet: () => "GWALLET" });
    const req = {} as Request;
    const res = fakeRes();
    const next = vi.fn();

    await gate(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.stellarcred).toEqual({ ok: true, results: { kyc: true }, missing: [], wallet: "GWALLET" });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("responds 403 with the failure taxonomy when a claim is missing", async () => {
    hasClaimsMock.mockResolvedValue({ kyc: false });
    const gate = stellarCredGate({ claims: ["kyc"], getWallet: () => "GWALLET" });
    const req = {} as Request;
    const res = fakeRes();
    const next = vi.fn();

    await gate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ error: "insufficient_claims", required: ["kyc"], missing: ["kyc"] });
  });

  it("treats a missing wallet as failing every requested claim", async () => {
    const gate = stellarCredGate({ claims: ["kyc", "age"], getWallet: () => undefined });
    const req = {} as Request;
    const res = fakeRes();
    const next = vi.fn();

    await gate(req, res, next);

    expect(hasClaimsMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ missing: ["kyc", "age"] });
  });

  it("redirects to the verify flow when onFail is 'redirect'", async () => {
    hasClaimsMock.mockResolvedValue({ kyc: false });
    buildVerifyUrlMock.mockReturnValue("https://stellarcred.xyz/verify?claim=kyc");
    const gate = stellarCredGate({
      claims: ["kyc"],
      getWallet: () => "GWALLET",
      onFail: "redirect",
      returnUrl: "/vault",
    });
    const req = {} as Request;
    const res = fakeRes();
    const next = vi.fn();

    await gate(req, res, next);

    expect(res.redirect).toHaveBeenCalledWith(302, "https://stellarcred.xyz/verify?claim=kyc");
  });

  it("passes RPC/config errors to next(err) instead of crashing", async () => {
    hasClaimsMock.mockRejectedValue(new Error("rpc down"));
    const gate = stellarCredGate({ claims: ["kyc"], getWallet: () => "GWALLET" });
    const req = {} as Request;
    const res = fakeRes();
    const next = vi.fn();

    await gate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
