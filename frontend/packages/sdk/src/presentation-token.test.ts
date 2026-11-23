import { beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";

import {
  DEFAULT_PRESENTATION_TOKEN_TTL_SECONDS,
  PRESENTATION_TOKEN_PREFIX,
  createPresentationToken,
  presentationTokenSigningMessage,
  verifyPresentationToken,
  type CreatePresentationTokenParams,
  type PresentationTokenPayload,
} from "./presentation-token";
import { verifyWalletSignature } from "./challenge";
import type { ClaimType, CredentialStatusResult } from "./claims";
import * as fromIndex from "./index";
import * as fromServer from "./server";

const { hasClaimMock, checkClaimStatusMock } = vi.hoisted(() => ({
  hasClaimMock: vi.fn(),
  checkClaimStatusMock: vi.fn(),
}));

vi.mock("./claims", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./claims")>();
  return {
    ...actual,
    hasClaim: hasClaimMock,
    checkClaimStatus: checkClaimStatusMock,
  };
});

const NOW = () => Math.floor(Date.now() / 1000);

function issue(kp: Keypair, overrides: Partial<CreatePresentationTokenParams> = {}) {
  return createPresentationToken({
    wallet: kp.publicKey(),
    claims: ["kyc"],
    sign: (message) => kp.sign(Buffer.from(message, "utf8")).toString("base64"),
    ...overrides,
  });
}

function basePayload(
  kp: Keypair,
  overrides: Partial<PresentationTokenPayload> = {},
): PresentationTokenPayload {
  const now = NOW();
  return {
    v: 1,
    wallet: kp.publicKey(),
    claims: ["kyc"],
    issuedAt: now,
    expiresAt: now + 300,
    ...overrides,
  };
}

function encodePayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signPayload(kp: Keypair, payload: unknown): string {
  const encoded = encodePayload(payload);
  const signature = kp
    .sign(Buffer.from(presentationTokenSigningMessage(encoded), "utf8"))
    .toString("base64url");
  return `${PRESENTATION_TOKEN_PREFIX}.${encoded}.${signature}`;
}

function payloadSegment(token: string): string {
  return token.split(".")[1] as string;
}

function decodedPayload(token: string): PresentationTokenPayload {
  return JSON.parse(Buffer.from(payloadSegment(token), "base64url").toString("utf8"));
}

const status = (value: Partial<CredentialStatusResult>): CredentialStatusResult => ({
  valid: false,
  status: "not_verified",
  record: null,
  ...value,
});

describe("presentation tokens (#1062)", () => {
  beforeEach(() => {
    hasClaimMock.mockReset().mockResolvedValue(true);
    checkClaimStatusMock.mockReset().mockResolvedValue(status({}));
  });

  describe("createPresentationToken", () => {
    it("creates a scpt1 token whose signature verifies with verifyWalletSignature", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);

      expect(token.startsWith(`${PRESENTATION_TOKEN_PREFIX}.`)).toBe(true);
      expect(token.split(".")).toHaveLength(3);

      const encoded = payloadSegment(token);
      const signature = token.split(".")[2] as string;
      expect(
        verifyWalletSignature(
          kp.publicKey(),
          presentationTokenSigningMessage(encoded),
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
    });

    it("defaults to a short expiry and records issuedAt/claims/version", async () => {
      const kp = Keypair.random();
      const before = NOW();
      const token = await issue(kp);
      const payload = decodedPayload(token);

      expect(payload.v).toBe(1);
      expect(payload.wallet).toBe(kp.publicKey());
      expect(payload.claims).toEqual(["kyc"]);
      expect(payload.issuedAt).toBeGreaterThanOrEqual(before);
      expect(payload.expiresAt).toBe(
        (payload.issuedAt as number) + DEFAULT_PRESENTATION_TOKEN_TTL_SECONDS,
      );
      expect(typeof payload.nonce).toBe("string");
    });

    it("accepts hex, base64url and raw-byte signatures from the signer", async () => {
      const kp = Keypair.random();
      const hexToken = await issue(kp, {
        sign: (message) => kp.sign(Buffer.from(message, "utf8")).toString("hex"),
      });
      const rawToken = await issue(kp, {
        sign: (message) => kp.sign(Buffer.from(message, "utf8")),
      });

      for (const token of [hexToken, rawToken]) {
        const result = await verifyPresentationToken(token, { verifyClaims: false });
        expect(result).toMatchObject({ ok: true, signatureValid: true });
      }
    });

    it("binds audience and a caller-supplied nonce into the payload", async () => {
      const kp = Keypair.random();
      const token = await issue(kp, { audience: "app.example.com", nonce: "nonce-1" });
      expect(decodedPayload(token)).toMatchObject({
        audience: "app.example.com",
        nonce: "nonce-1",
      });
    });

    it("rejects invalid wallets", async () => {
      const kp = Keypair.random();
      await expect(issue(kp, { wallet: "not-a-wallet" })).rejects.toBeInstanceOf(TypeError);
      await expect(issue(kp, { wallet: `  ${kp.publicKey()}  ` })).rejects.toBeInstanceOf(
        TypeError,
      );
      await expect(issue(kp, { wallet: "" })).rejects.toBeInstanceOf(TypeError);
    });

    it("rejects empty, unknown, duplicate, and oversized claim lists", async () => {
      const kp = Keypair.random();
      await expect(issue(kp, { claims: [] })).rejects.toBeInstanceOf(TypeError);
      await expect(issue(kp, { claims: ["bogus" as ClaimType] })).rejects.toBeInstanceOf(TypeError);
      await expect(issue(kp, { claims: ["kyc", "kyc"] })).rejects.toBeInstanceOf(TypeError);
      await expect(
        issue(kp, {
          claims: Array.from(
            { length: 17 },
            (_, index) =>
              (["kyc", "age", "funds", "income"] as ClaimType[])[index % 4] as ClaimType,
          ),
        }),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it("rejects impossible timestamps", async () => {
      const kp = Keypair.random();
      await expect(issue(kp, { issuedAt: 0 })).rejects.toBeInstanceOf(RangeError);
      await expect(issue(kp, { issuedAt: 1.5 })).rejects.toBeInstanceOf(RangeError);
      await expect(issue(kp, { issuedAt: NOW(), expiresAt: NOW() - 1 })).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(issue(kp, { expiresAt: 0 })).rejects.toBeInstanceOf(RangeError);
    });

    it("rejects empty audience/nonce and malformed signatures", async () => {
      const kp = Keypair.random();
      await expect(issue(kp, { audience: "  " })).rejects.toBeInstanceOf(TypeError);
      await expect(issue(kp, { nonce: "" })).rejects.toBeInstanceOf(TypeError);
      await expect(issue(kp, { sign: () => "short" })).rejects.toBeInstanceOf(TypeError);
      await expect(issue(kp, { sign: () => "not-base64-!!" })).rejects.toBeInstanceOf(TypeError);
    });

    it("wraps signer failures in a TypeError", async () => {
      const kp = Keypair.random();
      await expect(
        issue(kp, {
          sign: () => {
            throw new Error("wallet unavailable");
          },
        }),
      ).rejects.toThrow(/wallet unavailable/);
    });
  });

  describe("valid token verification", () => {
    it("verifies a token without on-chain checks when explicitly disabled", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);

      const result = await verifyPresentationToken(token, { verifyClaims: false });

      expect(result).toMatchObject({
        ok: true,
        wallet: kp.publicKey(),
        claims: ["kyc"],
        signatureValid: true,
        claimsChecked: false,
      });
      expect(result.payload?.claims).toEqual(["kyc"]);
      expect(result.failureReason).toBeUndefined();
      expect(hasClaimMock).not.toHaveBeenCalled();
    });

    it("verifies presented claims on-chain by default", async () => {
      const kp = Keypair.random();
      const token = await issue(kp, { claims: ["kyc", "age"] });
      const claimOptions = { trustedIssuers: ["GISSUER"] };

      const result = await verifyPresentationToken(token, { claimOptions });

      expect(result).toMatchObject({
        ok: true,
        wallet: kp.publicKey(),
        claims: ["kyc", "age"],
        signatureValid: true,
        claimsChecked: true,
        claimsValid: true,
      });
      expect(hasClaimMock).toHaveBeenCalledTimes(2);
      expect(hasClaimMock).toHaveBeenCalledWith(kp.publicKey(), "kyc", claimOptions);
      expect(hasClaimMock).toHaveBeenCalledWith(kp.publicKey(), "age", claimOptions);
      expect(checkClaimStatusMock).not.toHaveBeenCalled();
    });

    it("checks every presented claim even when only a subset is required", async () => {
      const kp = Keypair.random();
      const token = await issue(kp, { claims: ["kyc", "age"] });

      const result = await verifyPresentationToken(token, { requiredClaims: ["kyc"] });

      expect(result.ok).toBe(true);
      expect(hasClaimMock).toHaveBeenCalledTimes(2);
    });

    it("accepts a matching wallet expectation", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);

      const result = await verifyPresentationToken(token, {
        wallet: kp.publicKey(),
        verifyClaims: false,
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("malformed and tampered tokens", () => {
    it("returns malformed_token for missing, non-string, empty, or oversized input", async () => {
      for (const value of [undefined, null, 42, "", "   "]) {
        const result = await verifyPresentationToken(value as unknown as string, {
          verifyClaims: false,
        });
        expect(result.failureReason).toBe("malformed_token");
        expect(result.ok).toBe(false);
      }

      const oversized = `${PRESENTATION_TOKEN_PREFIX}.${"a".repeat(9000)}.sig`;
      expect((await verifyPresentationToken(oversized)).failureReason).toBe("malformed_token");
    });

    it("returns malformed_token for wrong segment counts or prefixes", async () => {
      const kp = Keypair.random();
      const valid = await issue(kp);
      const [, encoded, signature] = valid.split(".") as [string, string, string];

      const cases = [
        "not-a-token",
        "scpt1.only-two-parts",
        `scpt1.${encoded}.${signature}.extra`,
        `wrong.${encoded}.${signature}`,
        `scpt1..${signature}`,
        `scpt1.${encoded}.`,
        `scpt1.!!!.${signature}`,
        `scpt1.${Buffer.from("not json").toString("base64url")}.${signature}`,
      ];

      for (const token of cases) {
        const result = await verifyPresentationToken(token, { verifyClaims: false });
        expect(result.failureReason).toBe("malformed_token");
      }
    });

    it("rejects structurally invalid payloads", async () => {
      const kp = Keypair.random();
      const now = NOW();
      const cases: Array<[unknown, string]> = [
        [[], "invalid_payload"],
        [{ ...basePayload(kp), v: "1" }, "invalid_payload"],
        [{ ...basePayload(kp), v: 2 }, "unsupported_version"],
        [{ ...basePayload(kp), wallet: "not-a-wallet" }, "invalid_wallet"],
        [{ ...basePayload(kp), claims: [] }, "invalid_payload"],
        [{ ...basePayload(kp), claims: ["bogus"] }, "invalid_payload"],
        [{ ...basePayload(kp), claims: ["kyc", "kyc"] }, "invalid_payload"],
        [{ ...basePayload(kp), claims: "kyc" }, "invalid_payload"],
        [{ ...basePayload(kp), issuedAt: 0 }, "invalid_payload"],
        [{ ...basePayload(kp), issuedAt: 1.5 }, "invalid_payload"],
        [{ ...basePayload(kp), expiresAt: 0 }, "invalid_payload"],
        [{ ...basePayload(kp), expiresAt: now - 1 }, "invalid_payload"],
        [{ ...basePayload(kp), audience: "" }, "invalid_payload"],
        [{ ...basePayload(kp), nonce: 5 }, "invalid_payload"],
      ];

      for (const [payload, expected] of cases) {
        const result = await verifyPresentationToken(signPayload(kp, payload), {
          verifyClaims: false,
          clockSkewSeconds: 0,
        });
        expect(result.failureReason).toBe(expected);
      }
    });

    it("rejects a signature that is not valid base64url or not 64 bytes", async () => {
      const kp = Keypair.random();
      const encoded = encodePayload(basePayload(kp));

      const badEncoding = await verifyPresentationToken(
        `${PRESENTATION_TOKEN_PREFIX}.${encoded}.not*base64`,
        { verifyClaims: false },
      );
      expect(badEncoding.failureReason).toBe("malformed_token");

      const shortSignature = await verifyPresentationToken(
        `${PRESENTATION_TOKEN_PREFIX}.${encoded}.${Buffer.alloc(3).toString("base64url")}`,
        { verifyClaims: false },
      );
      expect(shortSignature.failureReason).toBe("invalid_signature");
    });

    it("rejects a token signed by a different key", async () => {
      const signer = Keypair.random();
      const victim = Keypair.random();
      const token = signPayload(signer, basePayload(victim));

      const result = await verifyPresentationToken(token, { verifyClaims: false });

      expect(result).toMatchObject({
        ok: false,
        wallet: victim.publicKey(),
        signatureValid: false,
        failureReason: "invalid_signature",
      });
      expect(hasClaimMock).not.toHaveBeenCalled();
    });

    it("rejects a token whose claims were altered after signing", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);
      const payload = decodedPayload(token);
      payload.claims = ["age"];

      const tampered = `${PRESENTATION_TOKEN_PREFIX}.${encodePayload(payload)}.${
        token.split(".")[2]
      }`;
      const result = await verifyPresentationToken(tampered, { verifyClaims: false });

      expect(result.failureReason).toBe("invalid_signature");
    });

    it("rejects a token whose wallet was altered after signing", async () => {
      const kp = Keypair.random();
      const other = Keypair.random();
      const token = await issue(kp);
      const payload = decodedPayload(token);
      payload.wallet = other.publicKey();

      const tampered = `${PRESENTATION_TOKEN_PREFIX}.${encodePayload(payload)}.${
        token.split(".")[2]
      }`;
      const result = await verifyPresentationToken(tampered, { verifyClaims: false });

      expect(result.failureReason).toBe("invalid_signature");
    });
  });

  describe("expiry and expectations", () => {
    it("rejects an expired token", async () => {
      const kp = Keypair.random();
      const now = NOW();
      const token = signPayload(kp, basePayload(kp, { issuedAt: now - 600, expiresAt: now - 1 }));

      const result = await verifyPresentationToken(token, {
        clockSkewSeconds: 0,
        verifyClaims: false,
      });

      expect(result).toMatchObject({
        ok: false,
        signatureValid: true,
        failureReason: "token_expired",
      });
    });

    it("tolerates small clock skew but not a long-expired token", async () => {
      const kp = Keypair.random();
      const now = NOW();

      const justExpired = signPayload(
        kp,
        basePayload(kp, { issuedAt: now - 400, expiresAt: now - 5 }),
      );
      expect((await verifyPresentationToken(justExpired, { verifyClaims: false })).ok).toBe(true);

      const longExpired = signPayload(
        kp,
        basePayload(kp, { issuedAt: now - 400, expiresAt: now - 120 }),
      );
      expect(
        (await verifyPresentationToken(longExpired, { verifyClaims: false })).failureReason,
      ).toBe("token_expired");
    });

    it("rejects a token issued in the future", async () => {
      const kp = Keypair.random();
      const now = NOW();
      const token = signPayload(kp, basePayload(kp, { issuedAt: now + 300, expiresAt: now + 600 }));

      const result = await verifyPresentationToken(token, {
        clockSkewSeconds: 0,
        verifyClaims: false,
      });

      expect(result.failureReason).toBe("token_not_yet_valid");
    });

    it("requires expiresAt by default and allows opting out", async () => {
      const kp = Keypair.random();
      const payload = basePayload(kp);
      delete payload.expiresAt;
      const token = signPayload(kp, payload);

      expect((await verifyPresentationToken(token, { verifyClaims: false })).failureReason).toBe(
        "expiry_required",
      );
      expect(
        (await verifyPresentationToken(token, { requireExpiry: false, verifyClaims: false })).ok,
      ).toBe(true);
    });

    it("enforces required claims, wallet, and audience bindings", async () => {
      const kp = Keypair.random();
      const other = Keypair.random();
      const token = await issue(kp, { claims: ["kyc"], audience: "app.example.com" });
      const options = { verifyClaims: false } as const;

      expect(
        (await verifyPresentationToken(token, { ...options, requiredClaims: ["kyc"] })).ok,
      ).toBe(true);

      const missingClaim = await verifyPresentationToken(token, {
        ...options,
        requiredClaims: ["age"],
      });
      expect(missingClaim).toMatchObject({
        failureReason: "claim_missing",
        failedClaim: "age",
      });

      const wrongWallet = await verifyPresentationToken(token, {
        ...options,
        wallet: other.publicKey(),
      });
      expect(wrongWallet.failureReason).toBe("wallet_mismatch");

      expect(
        (await verifyPresentationToken(token, { ...options, audience: "app.example.com" })).ok,
      ).toBe(true);
      expect(
        (await verifyPresentationToken(token, { ...options, audience: "evil.example.com" }))
          .failureReason,
      ).toBe("audience_mismatch");
    });

    it("rejects a token that does not carry the expected audience", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);

      const result = await verifyPresentationToken(token, {
        audience: "app.example.com",
        verifyClaims: false,
      });

      expect(result.failureReason).toBe("audience_mismatch");
    });

    it("returns invalid_options for invalid verification options", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);

      const invalidOptionCases = [
        { clockSkewSeconds: -1 },
        { clockSkewSeconds: 1.5 },
        { requiredClaims: ["bogus" as ClaimType] },
        { requiredClaims: "kyc" as unknown as ClaimType[] },
        { audience: "  " },
        { wallet: "" },
        { claimOptions: "nope" as never },
        null as unknown as Record<string, never>,
      ];

      for (const options of invalidOptionCases) {
        const result = await verifyPresentationToken(token, options as never);
        expect(result.failureReason).toBe("invalid_options");
      }
    });

    it("returns invalid_options for an invalid expected wallet", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);

      const result = await verifyPresentationToken(token, {
        wallet: "not-a-wallet",
        verifyClaims: false,
      });

      expect(result.failureReason).toBe("invalid_options");
    });
  });

  describe("credential verification failures", () => {
    it("reports an expired credential with its on-chain status", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);
      const expiredStatus = status({
        status: "expired",
        error: 'Credential "kyc" expired yesterday.',
      });
      hasClaimMock.mockResolvedValue(false);
      checkClaimStatusMock.mockResolvedValue(expiredStatus);

      const result = await verifyPresentationToken(token);

      expect(result).toMatchObject({
        ok: false,
        signatureValid: true,
        claimsChecked: true,
        claimsValid: false,
        failedClaim: "kyc",
        failureReason: "credential_expired",
      });
      expect(result.claimStatuses?.kyc).toEqual(expiredStatus);
      expect(result.error).toContain("expired yesterday");
    });

    it("reports a revoked credential", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);
      hasClaimMock.mockResolvedValue(false);
      checkClaimStatusMock.mockResolvedValue(status({ status: "revoked" }));

      const result = await verifyPresentationToken(token);

      expect(result.failureReason).toBe("credential_revoked");
    });

    it("reports a missing credential", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);
      hasClaimMock.mockResolvedValue(false);
      checkClaimStatusMock.mockResolvedValue(status({ status: "not_verified" }));

      const result = await verifyPresentationToken(token);

      expect(result.failureReason).toBe("claim_not_verified");
      expect(result.claimsValid).toBe(false);
    });

    it("returns on_chain_error when the registry read throws", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);
      hasClaimMock.mockRejectedValue(new Error("rpc unavailable"));

      const result = await verifyPresentationToken(token, {
        claimOptions: { throwOnError: true },
      });

      expect(result).toMatchObject({
        ok: false,
        signatureValid: true,
        failureReason: "on_chain_error",
      });
      expect(result.error).toContain("rpc unavailable");
    });

    it("still fails safely when the status detail read throws", async () => {
      const kp = Keypair.random();
      const token = await issue(kp);
      hasClaimMock.mockResolvedValue(false);
      checkClaimStatusMock.mockRejectedValue(new Error("rpc down"));

      const result = await verifyPresentationToken(token);

      expect(result).toMatchObject({
        ok: false,
        failureReason: "claim_not_verified",
        failedClaim: "kyc",
      });
      expect(result.claimStatuses).toEqual({});
    });

    it("reports the first failing claim in token order", async () => {
      const kp = Keypair.random();
      const token = await issue(kp, { claims: ["kyc", "age", "funds"] });
      hasClaimMock.mockImplementation(async (_wallet: string, claim: string) => claim !== "age");
      checkClaimStatusMock.mockResolvedValue(status({ status: "revoked" }));

      const result = await verifyPresentationToken(token);

      expect(result.failedClaim).toBe("age");
      expect(result.failureReason).toBe("credential_revoked");
    });
  });
});

describe("presentation token exports", () => {
  it("exposes create/verify from the main and server entry points", () => {
    expect(fromIndex.verifyPresentationToken).toBe(verifyPresentationToken);
    expect(fromIndex.createPresentationToken).toBe(createPresentationToken);
    expect(fromServer.verifyPresentationToken).toBe(verifyPresentationToken);
    expect(fromServer.createPresentationToken).toBe(createPresentationToken);
    expect(fromIndex.StellarCred.verifyPresentationToken).toBe(verifyPresentationToken);
    expect(fromIndex.StellarCred.createPresentationToken).toBe(createPresentationToken);
  });
});
