// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { POST } from "../route";
import { clearIssuanceCallbacks, getIssuanceCallback } from "@/lib/webhooks";

const TEST_SECRET = "test_issuance_secret_123456";

function makeSignedRequest(
  body: string,
  secret = TEST_SECRET,
  headerName = "x-issuance-signature"
) {
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  const headers = new Headers({
    "Content-Type": "application/json",
    [headerName]: sig,
  });
  return new NextRequest("http://localhost:3000/api/webhooks/issuance", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/webhooks/issuance (#846)", () => {
  const originalSecret = process.env.ISSUANCE_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.ISSUANCE_WEBHOOK_SECRET = TEST_SECRET;
    clearIssuanceCallbacks();
  });

  it("returns 500 when webhook secret is not configured", async () => {
    delete process.env.ISSUANCE_WEBHOOK_SECRET;
    delete process.env.WEBHOOK_SECRET;

    const req = new NextRequest("http://localhost:3000/api/webhooks/issuance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("not configured");
  });

  it("returns 401 when signature header is missing", async () => {
    const req = new NextRequest("http://localhost:3000/api/webhooks/issuance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "evt_1", status: "completed" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain("signature");
  });

  it("returns 401 when signature is invalid", async () => {
    const body = JSON.stringify({ eventId: "evt_1", status: "completed" });
    const req = makeSignedRequest(body, "wrong_secret");

    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toContain("signature");
  });

  it("returns 400 when payload is malformed", async () => {
    const body = "not_valid_json";
    const req = makeSignedRequest(body, TEST_SECRET);

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Malformed");
  });

  it("returns 200 and records valid callback", async () => {
    const payload = {
      eventId: "evt_test_success_123",
      provider: "persona",
      status: "completed",
      credentialType: "kyc",
      walletAddress: "GBZXN7PIRZGNMHGA728JDOQTT2TWSTTRNMG2YJYBC6QUFFJWDT5V37O7",
    };
    const body = JSON.stringify(payload);
    const req = makeSignedRequest(body, TEST_SECRET);

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.eventId).toBe("evt_test_success_123");
    expect(data.status).toBe("completed");

    // Verify stored state
    const stored = getIssuanceCallback("evt_test_success_123");
    expect(stored).toBeDefined();
    expect(stored?.status).toBe("completed");
    expect(stored?.credentialType).toBe("kyc");
  });
});
