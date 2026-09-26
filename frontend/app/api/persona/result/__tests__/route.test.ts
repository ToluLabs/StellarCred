// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import {
  clearPersonaCaches,
  setInquiryResult,
  registerPendingInquiry,
} from "@/lib/persona-webhook";
import type { Credential } from "@stellarcred/issuer";

describe("GET /api/persona/result", () => {
  beforeEach(() => {
    clearPersonaCaches();
  });

  it("returns 400 if inquiry_id parameter is missing", async () => {
    const req = new NextRequest("http://localhost:3000/api/persona/result");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("inquiry_id");
  });

  it("returns ready: false and status: pending when inquiry is registered but not completed", async () => {
    registerPendingInquiry("inq_pending", {
      holder: "G111",
      issuerId: "G222",
      credentialTypes: ["kyc"],
    });

    const req = new NextRequest("http://localhost:3000/api/persona/result?inquiry_id=inq_pending");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ready).toBe(false);
    expect(json.status).toBe("pending");
  });

  it("returns ready: false and status: failed when inquiry result is failed", async () => {
    setInquiryResult("inq_failed", {
      status: "failed",
      error: "User did not match selfie",
    });

    const req = new NextRequest("http://localhost:3000/api/persona/result?inquiry_id=inq_failed");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ready).toBe(false);
    expect(json.status).toBe("failed");
    expect(json.error).toBe("User did not match selfie");
  });

  it("returns ready: true and credentials when inquiry result is completed", async () => {
    const mockCred: Credential = {
      type: "kyc",
      title: "Identity Verified",
      claim: "identity verified",
      issuer: "StellarCred Authority",
      issuerId: "G222",
      holder: "G111",
      value: "0x123",
      salt: "0x456",
      commitment: "0x789",
      sig: [1, 2, 3],
      issuerPubX: [1],
      issuerPubY: [2],
      issuedAt: 1000,
      expiry: "90 days",
    };

    setInquiryResult("inq_complete", {
      status: "completed",
      credentials: [mockCred],
    });

    const req = new NextRequest("http://localhost:3000/api/persona/result?inquiry_id=inq_complete");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ready).toBe(true);
    expect(json.status).toBe("completed");
    expect(json.credentials).toHaveLength(1);
    expect(json.credentials[0].commitment).toBe("0x789");
  });
});
