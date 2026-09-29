// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";

const HOLDER_1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const HOLDER_2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";
const HOLDER_3 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF3";

vi.mock("@/lib/issuer-registry", () => ({
  fetchIssuerPubkey: vi.fn(),
}));

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/issue/batch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/issue/batch", () => {
  beforeEach(() => {
    delete process.env.ISSUER_PRIVATE_KEY;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when body is not an array or has no items", async () => {
    const resEmpty = await POST(postRequest({ requests: [] }));
    expect(resEmpty.status).toBe(400);
    const bodyEmpty = await resEmpty.json();
    expect(bodyEmpty.error).toMatch(/non-empty array/i);

    const resArrayEmpty = await POST(postRequest([]));
    expect(resArrayEmpty.status).toBe(400);
  });

  it("returns 400 when batch size exceeds maximum limit", async () => {
    const tooMany = Array.from({ length: 51 }, () => ({
      holder: HOLDER_1,
      type: "kyc",
    }));
    const res = await POST(postRequest({ requests: tooMany }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/exceeds maximum allowed of 50/i);
  });

  it("issues credentials in batch successfully across multiple holders", async () => {
    const req = postRequest([
      {
        holder: HOLDER_1,
        credential_types: ["kyc"],
      },
      {
        holder: HOLDER_2,
        type: "age",
        attribute: "1995-05-10",
      },
    ]);

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.successful).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.results).toHaveLength(2);

    expect(data.results[0].success).toBe(true);
    expect(data.results[0].holder).toBe(HOLDER_1);
    expect(data.results[0].credentials).toHaveLength(1);
    expect(data.results[0].credentials[0].type).toBe("kyc");

    expect(data.results[1].success).toBe(true);
    expect(data.results[1].holder).toBe(HOLDER_2);
    expect(data.results[1].credentials).toHaveLength(1);
    expect(data.results[1].credentials[0].type).toBe("age");
  });

  it("handles partial failure without failing the entire batch", async () => {
    const req = postRequest([
      {
        holder: HOLDER_1,
        credential_types: ["kyc"],
      },
      {
        // Missing holder
        credential_types: ["kyc"],
      },
      {
        holder: HOLDER_2,
        credential_types: ["invalid_nonexistent_type"],
      },
      {
        holder: HOLDER_3,
        type: "jurisdiction",
        attribute: "840",
      },
    ]);

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.total).toBe(4);
    expect(data.successful).toBe(2);
    expect(data.failed).toBe(2);

    // Item 0: success
    expect(data.results[0].success).toBe(true);
    expect(data.results[0].holder).toBe(HOLDER_1);

    // Item 1: failure (missing holder)
    expect(data.results[1].success).toBe(false);
    expect(data.results[1].error).toMatch(/holder address is required/i);

    // Item 2: failure (invalid credential type)
    expect(data.results[2].success).toBe(false);
    expect(data.results[2].error).toMatch(/invalid credential type/i);

    // Item 3: success
    expect(data.results[3].success).toBe(true);
    expect(data.results[3].holder).toBe(HOLDER_3);
  });

  it("supports idempotency replay with Idempotency-Key header", async () => {
    const key = "test-batch-key-123456789";
    const payload = [
      {
        holder: HOLDER_1,
        type: "kyc",
      },
    ];

    const res1 = await POST(postRequest(payload, { "Idempotency-Key": key }));
    expect(res1.status).toBe(200);
    const data1 = await res1.json();

    const res2 = await POST(postRequest(payload, { "Idempotency-Key": key }));
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-Idempotent")).toBe("true");
    const data2 = await res2.json();
    expect(data2).toEqual(data1);
  });
});
