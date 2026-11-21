// frontend/lib/webhooks.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import {
  verifyWebhookSignature,
  parseAndNormalizeCallback,
  sanitizeWebhookPayload,
  recordIssuanceCallback,
  getIssuanceCallback,
  clearIssuanceCallbacks,
} from "./webhooks";

const TEST_SECRET = "test_webhook_secret_key_123456789";

describe("Webhook Signature Verification (#846)", () => {
  it("verifies a valid HMAC-SHA256 hex signature", () => {
    const body = JSON.stringify({ eventId: "evt_1", status: "completed" });
    const sig = crypto.createHmac("sha256", TEST_SECRET).update(body).digest("hex");

    expect(verifyWebhookSignature(body, sig, TEST_SECRET)).toBe(true);
  });

  it("verifies a signature prefixed with sha256=", () => {
    const body = JSON.stringify({ eventId: "evt_2", status: "completed" });
    const sig = "sha256=" + crypto.createHmac("sha256", TEST_SECRET).update(body).digest("hex");

    expect(verifyWebhookSignature(body, sig, TEST_SECRET)).toBe(true);
  });

  it("verifies a timestamped signature t=...,v1=...", () => {
    const body = JSON.stringify({ eventId: "evt_3", status: "approved" });
    const now = Math.floor(Date.now() / 1000);
    const hash = crypto.createHmac("sha256", TEST_SECRET).update(`${now}.${body}`).digest("hex");
    const header = `t=${now},v1=${hash}`;

    expect(verifyWebhookSignature(body, header, TEST_SECRET)).toBe(true);
  });

  it("rejects an expired timestamp in t=...,v1=...", () => {
    const body = JSON.stringify({ eventId: "evt_3", status: "approved" });
    const past = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const hash = crypto.createHmac("sha256", TEST_SECRET).update(`${past}.${body}`).digest("hex");
    const header = `t=${past},v1=${hash}`;

    expect(verifyWebhookSignature(body, header, TEST_SECRET)).toBe(false);
  });

  it("rejects an invalid signature", () => {
    const body = JSON.stringify({ eventId: "evt_4" });
    const badSig = "0000000000000000000000000000000000000000000000000000000000000000";

    expect(verifyWebhookSignature(body, badSig, TEST_SECRET)).toBe(false);
  });

  it("rejects missing signature or secret", () => {
    expect(verifyWebhookSignature("body", null, TEST_SECRET)).toBe(false);
    expect(verifyWebhookSignature("body", "sig", "")).toBe(false);
  });
});

describe("Webhook Payload Parsing & Sanitization (#846)", () => {
  beforeEach(() => {
    clearIssuanceCallbacks();
  });

  it("parses and normalizes standard issuance payload", () => {
    const raw = JSON.stringify({
      eventId: "evt_test_100",
      provider: "kyc_corp",
      eventType: "issuance.completed",
      status: "completed",
      credentialType: "kyc",
      timestamp: 1700000000,
      walletAddress: "GBZXN7PIRZGNMHGA728JDOQTT2TWSTTRNMG2YJYBC6QUFFJWDT5V37O7",
    });

    const normalized = parseAndNormalizeCallback(raw);
    expect(normalized).not.toBeNull();
    expect(normalized?.eventId).toBe("evt_test_100");
    expect(normalized?.provider).toBe("kyc_corp");
    expect(normalized?.status).toBe("completed");
    expect(normalized?.credentialType).toBe("kyc");
  });

  it("parses and normalizes Persona webhook shape", () => {
    const raw = {
      name: "inquiry.completed",
      data: {
        id: "inq_999",
        attributes: {
          status: "approved",
          fields: {
            wallet_address: { value: "GA123..." },
            credential_type: { value: "age" },
          },
        },
      },
    };

    const normalized = parseAndNormalizeCallback(raw);
    expect(normalized).not.toBeNull();
    expect(normalized?.provider).toBe("persona");
    expect(normalized?.status).toBe("completed");
    expect(normalized?.credentialType).toBe("age");
    expect(normalized?.inquiryId).toBe("inq_999");
    expect(normalized?.walletAddress).toBe("GA123...");
  });

  it("sanitizes sensitive keys from payload metadata", () => {
    const dirty = {
      secret: "sensitive_secret_here",
      apiKey: "secret_api_key",
      token: "bearer_token",
      ssn: "123-45-6789",
      safeInfo: "allowed_metadata",
      nested: {
        privateKey: "privkey_123",
        level: "tier_1",
      },
    };

    const sanitized = sanitizeWebhookPayload(dirty);
    expect(sanitized.secret).toBeUndefined();
    expect(sanitized.apiKey).toBeUndefined();
    expect(sanitized.token).toBeUndefined();
    expect(sanitized.ssn).toBeUndefined();
    expect(sanitized.safeInfo).toBe("allowed_metadata");
    expect((sanitized.nested as any)?.privateKey).toBeUndefined();
    expect((sanitized.nested as any)?.level).toBe("tier_1");
  });

  it("stores and retrieves callback records for reconciliation", () => {
    const event = {
      eventId: "evt_rec_1",
      provider: "custom",
      eventType: "issuance.completed",
      status: "completed" as const,
      credentialType: "kyc",
      timestamp: Date.now(),
    };

    recordIssuanceCallback(event);
    expect(getIssuanceCallback("evt_rec_1")).toEqual(event);
    expect(getIssuanceCallback("non_existent")).toBeUndefined();
  });
});
