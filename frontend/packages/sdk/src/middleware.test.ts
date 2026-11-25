import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRoutePresentation, validateRouteProtectionOptions, verifyRoutePresentation, type RouteProtectionOptions } from "./middleware";
import { verifyPreset } from "./claims";
import { verifyWalletClaim } from "./challenge";

vi.mock("./claims", () => ({
  isValidClaimType: (value: string) => ["kyc", "age"].includes(value),
  verifyPreset: vi.fn(),
}));
vi.mock("./challenge", () => ({ verifyWalletClaim: vi.fn() }));

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const issuedAt = Date.now();
const expiresAt = issuedAt + 60_000;
const challenge = { nonce: "nonce", issuedAt, expiresAt, domain: "app.example", statement: "access", message: ["app.example requests you sign this message to prove control of your Stellar account:", "", "Statement: access", "Nonce: nonce", "Issued At: " + new Date(issuedAt).toISOString(), "Expires At: " + new Date(expiresAt).toISOString()].join("\n") };
const presentation = { wallet: "G".repeat(56), challenge, signature: "signature" };
const base: RouteProtectionOptions = { schema: [{ type: "kyc" }], predicate: () => true };

describe("route protection middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses a correctly encoded presentation", () => {
    expect(parseRoutePresentation(encode(presentation), 4096)).toEqual(presentation);
  });

  it("rejects malformed, non-canonical, and oversized presentations", () => {
    expect(parseRoutePresentation("not-json", 4096)).toBeNull();
    expect(parseRoutePresentation(encode({ wallet: "G", challenge, signature: "sig" }) + "=", 4096)).toBeNull();
    expect(parseRoutePresentation(encode({ wallet: "G", challenge, signature: "sig" }), 4)).toBeNull();
  });

  it("requires a schema, predicate, valid threshold, and bounded header size", () => {
    expect(() => validateRouteProtectionOptions(base)).not.toThrow();
    expect(() => validateRouteProtectionOptions({ ...base, schema: [] })).toThrow(TypeError);
    expect(() => validateRouteProtectionOptions({ ...base, predicate: undefined } as unknown as RouteProtectionOptions)).toThrow(TypeError);
    expect(() => validateRouteProtectionOptions({ ...base, schema: [{ type: "kyc", minThreshold: -1 }] })).toThrow(TypeError);
    expect(() => validateRouteProtectionOptions({ ...base, maxPresentationBytes: 0 })).toThrow(TypeError);
  });

  it("verifies signed ownership, on-chain schema and route predicate", async () => {
    vi.mocked(verifyWalletClaim).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof verifyWalletClaim>>);
    vi.mocked(verifyPreset).mockResolvedValue({ allValid: true, results: { kyc: true } });
    const request = { path: "/private" };
    const result = await verifyRoutePresentation(encode(presentation), request, { ...base, predicate: (_credential, req) => req.path === "/private" });
    expect(result.ok).toBe(true);
    expect(verifyWalletClaim).toHaveBeenCalledWith(expect.objectContaining({
      wallet: presentation.wallet, signature: presentation.signature, claim: "kyc",
      claimOptions: { source: "chain", fresh: true, throwOnError: true },
    }));
    expect(verifyPreset).toHaveBeenCalledWith(presentation.wallet, base.schema, { source: "chain", fresh: true, throwOnError: true });
  });

  it("rejects tampered challenge metadata before consuming the challenge", async () => {
    const tampered = { ...presentation, challenge: { ...challenge, domain: "other.example" } };
    const result = await verifyRoutePresentation(encode(tampered), {}, base);
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(verifyWalletClaim).not.toHaveBeenCalled();
  });

  it("rejects a failed route predicate", async () => {
    vi.mocked(verifyWalletClaim).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof verifyWalletClaim>>);
    vi.mocked(verifyPreset).mockResolvedValue({ allValid: true, results: { kyc: true } });
    const result = await verifyRoutePresentation(encode(presentation), {}, { ...base, predicate: () => false });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });
});
