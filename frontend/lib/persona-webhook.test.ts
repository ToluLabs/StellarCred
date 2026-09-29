// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyPersonaSignature,
  parsePersonaWebhook,
  registerPendingInquiry,
  getPendingInquiry,
  setInquiryResult,
  getInquiryResult,
  clearPersonaCaches,
  alpha2ToNumeric,
} from "./persona-webhook";

describe("persona-webhook", () => {
  const secret = "test_webhook_secret_key_12345";
  const body = JSON.stringify({
    data: {
      type: "event",
      id: "evt_123",
      attributes: {
        name: "inquiry.completed",
        payload: {
          data: {
            id: "inq_abc456",
            attributes: {
              status: "approved",
              "reference-id": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
              fields: {
                birthdate: { value: "1995-05-15" },
                "selected-country-code": { value: "US" },
              },
            },
          },
        },
      },
    },
  });

  beforeEach(() => {
    clearPersonaCaches();
  });

  describe("verifyPersonaSignature", () => {
    it("accepts a valid signature with current timestamp", () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", secret)
        .update(`${now}.${body}`)
        .digest("hex");
      const header = `t=${now},v1=${signature}`;

      expect(verifyPersonaSignature(body, header, secret)).toBe(true);
    });

    it("accepts valid signature among multiple v1 values (key rotation)", () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", secret)
        .update(`${now}.${body}`)
        .digest("hex");
      const header = `t=${now}, v1=0000000000000000000000000000000000000000000000000000000000000000, v1=${signature}`;

      expect(verifyPersonaSignature(body, header, secret)).toBe(true);
    });

    it("rejects when signature does not match", () => {
      const now = Math.floor(Date.now() / 1000);
      const header = `t=${now},v1=bad_signature`;

      expect(verifyPersonaSignature(body, header, secret)).toBe(false);
    });

    it("rejects when rawBody was tampered with", () => {
      const now = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", secret)
        .update(`${now}.${body}`)
        .digest("hex");
      const header = `t=${now},v1=${signature}`;
      const tamperedBody = body + " ";

      expect(verifyPersonaSignature(tamperedBody, header, secret)).toBe(false);
    });

    it("rejects when timestamp is older than tolerance (replay attack protection)", () => {
      const oldTime = Math.floor(Date.now() / 1000) - 301; // 301s ago (> 300s tolerance)
      const signature = createHmac("sha256", secret)
        .update(`${oldTime}.${body}`)
        .digest("hex");
      const header = `t=${oldTime},v1=${signature}`;

      expect(verifyPersonaSignature(body, header, secret)).toBe(false);
    });

    it("rejects when header is missing or empty", () => {
      expect(verifyPersonaSignature(body, null, secret)).toBe(false);
      expect(verifyPersonaSignature(body, "", secret)).toBe(false);
      expect(verifyPersonaSignature(body, "malformed", secret)).toBe(false);
    });

    it("rejects when secret is empty", () => {
      const now = Math.floor(Date.now() / 1000);
      const header = `t=${now},v1=some_sig`;
      expect(verifyPersonaSignature(body, header, "")).toBe(false);
    });
  });

  describe("parsePersonaWebhook", () => {
    it("correctly parses Persona event payload", () => {
      const event = parsePersonaWebhook(body);
      expect(event).not.toBeNull();
      expect(event?.eventName).toBe("inquiry.completed");
      expect(event?.inquiryId).toBe("inq_abc456");
      expect(event?.status).toBe("approved");
      expect(event?.referenceId).toBe("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
      expect(event?.fields["birthdate"]?.value).toBe("1995-05-15");
      expect(event?.fields["selected-country-code"]?.value).toBe("US");
    });

    it("returns null for non-JSON or missing inquiryId", () => {
      expect(parsePersonaWebhook("not a json")).toBeNull();
      expect(parsePersonaWebhook(JSON.stringify({ data: {} }))).toBeNull();
    });
  });

  describe("caching & PII protection", () => {
    it("stores and retrieves pending inquiry metadata without PII", () => {
      registerPendingInquiry("inq_123", {
        holder: "G11111111111111111111111111111111111111111111111111111111",
        issuerId: "G22222222222222222222222222222222222222222222222222222222",
        issuerName: "Test Issuer",
        expiry: "90 days",
        credentialTypes: ["kyc"],
      });

      const pending = getPendingInquiry("inq_123");
      expect(pending).toBeDefined();
      expect(pending?.holder).toBe("G11111111111111111111111111111111111111111111111111111111");
      expect(pending?.credentialTypes).toEqual(["kyc"]);
    });

    it("stores and retrieves inquiry result containing only credentials", () => {
      setInquiryResult("inq_456", {
        status: "completed",
        credentials: [
          {
            type: "kyc",
            title: "Identity Verified",
            claim: "identity verified",
            issuer: "Test Issuer",
            issuerId: "G222",
            holder: "G111",
            value: "0x123",
            salt: "0x456",
            commitment: "0x789",
            sig: [1, 2, 3],
            issuerPubX: [1],
            issuerPubY: [2],
            issuedAt: 123456,
            expiry: "90 days",
          },
        ],
      });

      const result = getInquiryResult("inq_456");
      expect(result).toBeDefined();
      expect(result?.status).toBe("completed");
      expect(result?.credentials?.length).toBe(1);
      expect(result?.credentials?.[0].commitment).toBe("0x789");
    });
  });

  describe("alpha2ToNumeric", () => {
    it("converts known alpha-2 codes to numeric string", () => {
      expect(alpha2ToNumeric("US")).toBe("840");
      expect(alpha2ToNumeric("NG")).toBe("566");
      expect(alpha2ToNumeric("DE")).toBe("276");
    });

    it("falls back to 0 for unknown country codes", () => {
      expect(alpha2ToNumeric("ZZ")).toBe("0");
    });
  });
});
