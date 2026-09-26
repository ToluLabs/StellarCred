// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { POST } from "../route";
import {
  clearPersonaCaches,
  registerPendingInquiry,
  getInquiryResult,
} from "@/lib/persona-webhook";

const WEBHOOK_SECRET = "whsec_test_secret_1234567890";

// Mock env
vi.mock("@/lib/env", () => ({
  env: {
    PERSONA_WEBHOOK_SECRET: "whsec_test_secret_1234567890",
    PERSONA_API_KEY: undefined,
    NEXT_PUBLIC_ISSUER_ADDRESS:
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    ISSUER_PRIVATE_KEY: undefined,
  },
}));

function makeSignedRequest(body: string, secret = WEBHOOK_SECRET, timestamp?: number) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const headers = new Headers({
    "Content-Type": "application/json",
    "Persona-Signature": `t=${ts},v1=${sig}`,
  });
  return new NextRequest("http://localhost:3000/api/persona/webhook", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/persona/webhook", () => {
  beforeEach(() => {
    clearPersonaCaches();
  });

  it("returns 401 if Persona-Signature header is missing", async () => {
    const req = new NextRequest("http://localhost:3000/api/persona/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain("signature");
  });

  it("returns 401 if signature is invalid", async () => {
    const body = JSON.stringify({ hello: "world" });
    const req = makeSignedRequest(body, "wrong_secret");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed payload without inquiryId", async () => {
    const body = JSON.stringify({ data: { type: "unknown" } });
    const req = makeSignedRequest(body);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 200 ignored for non-completion events", async () => {
    const body = JSON.stringify({
      data: {
        id: "evt_1",
        attributes: {
          name: "inquiry.created",
          status: "created",
          payload: {
            data: {
              id: "inq_1",
              attributes: { status: "created" },
            },
          },
        },
      },
    });
    const req = makeSignedRequest(body);
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ignored");
  });

  it("records failure when inquiry was declined", async () => {
    const inquiryId = "inq_declined_123";
    const body = JSON.stringify({
      data: {
        id: "evt_2",
        attributes: {
          name: "inquiry.completed",
          payload: {
            data: {
              id: inquiryId,
              attributes: { status: "declined" },
            },
          },
        },
      },
    });
    const req = makeSignedRequest(body);
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("recorded_failed");

    const cached = getInquiryResult(inquiryId);
    expect(cached?.status).toBe("failed");
  });

  it("signs and caches credentials on approved inquiry without persisting PII", async () => {
    const inquiryId = "inq_approved_123";
    const holder = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    registerPendingInquiry(inquiryId, {
      holder,
      issuerId: holder,
      issuerName: "StellarCred Authority",
      credentialTypes: ["kyc"],
      expiry: "90 days",
    });

    const body = JSON.stringify({
      data: {
        id: "evt_3",
        attributes: {
          name: "inquiry.completed",
          payload: {
            data: {
              id: inquiryId,
              attributes: {
                status: "approved",
                "reference-id": holder,
                fields: {
                  birthdate: { value: "1990-01-01" },
                  "selected-country-code": { value: "US" },
                },
              },
            },
          },
        },
      },
    });

    const req = makeSignedRequest(body);
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.inquiryId).toBe(inquiryId);

    const result = getInquiryResult(inquiryId);
    expect(result).toBeDefined();
    expect(result?.status).toBe("completed");
    expect(result?.credentials?.length).toBe(1);

    const cred = result?.credentials?.[0];
    expect(cred?.type).toBe("kyc");
    expect(cred?.holder).toBe(holder);
    expect(cred?.commitment).toBeDefined();
    expect(cred?.sig).toBeDefined();

    // Verify NO identity fields are in the result cache entry
    const rawResult = result as unknown as Record<string, unknown>;
    expect(rawResult["birthdate"]).toBeUndefined();
    expect(rawResult["fields"]).toBeUndefined();
    expect(rawResult["name"]).toBeUndefined();
  });
});
