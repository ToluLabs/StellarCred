// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";
import { idempotencyGetAsync } from "@/lib/idempotency";

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
    process.env.IDEMPOTENCY_REPLAY_ENCRYPTION_KEY = "a".repeat(64);
  });

  afterEach(() => {
    process.env.IDEMPOTENCY_REPLAY_ENCRYPTION_KEY = "a".repeat(64);
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

  it("rejects the whole batch without returning partial credentials", async () => {
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
    expect(res.status).toBe(422);

    const data = await res.json();
    expect(data.total).toBe(4);
    expect(data.successful).toBe(0);
    expect(data.failed).toBe(4);
    expect(data.results).toHaveLength(4);
    expect(data.results.every((result: { success: boolean }) => !result.success)).toBe(true);
    expect(JSON.stringify(data)).not.toContain('"credentials"');
    expect(data.results[0].error).toMatch(/aborted/i);
    expect(data.results[1].error).toMatch(/holder address is required/i);
  });

  it("replays the exact successful response from an encrypted cache record", async () => {
    const key = "test-batch-key-123456789";
    const payload = [
      {
        holder: HOLDER_1,
        type: "kyc",
      },
    ];

    const res1 = await POST(postRequest(payload, { "Idempotency-Key": key }));
    expect(res1.status).toBe(200);
    const firstResponse = await res1.clone().json();
    const data1 = await res1.json();
    expect(data1.results[0].credentials).toHaveLength(1);

    const record = await idempotencyGetAsync(key);
    expect(record?.kind).toBe("encrypted_response");
    expect(JSON.stringify(record)).not.toContain(JSON.stringify(data1.results[0].credentials));

    const res2 = await POST(postRequest(payload, { "Idempotency-Key": key }));
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-Idempotent")).toBe("true");
    expect(res2.headers.get("X-Idempotency-Replay")).toBe("restored");
    await expect(res2.json()).resolves.toEqual(firstResponse);
  });

  it("requires an encryption key before accepting idempotent batch issuance", async () => {
    delete process.env.IDEMPOTENCY_REPLAY_ENCRYPTION_KEY;
    const res = await POST(postRequest([{ holder: HOLDER_1, type: "kyc" }], {
      "Idempotency-Key": "missing-encryption-key",
    }));
    expect(res.status).toBe(503);
  });

  it("allows a corrected retry after a failed batch", async () => {
    const key = "batch-retry-after-failure";
    const failed = await POST(
      postRequest([{ type: "kyc" }], { "Idempotency-Key": key }),
    );
    expect(failed.status).toBe(422);

    const retried = await POST(
      postRequest([{ holder: HOLDER_1, type: "kyc" }], { "Idempotency-Key": key }),
    );
    expect(retried.status).toBe(200);
    const body = await retried.json();
    expect(body.successful).toBe(1);
    expect(body.results[0].credentials).toHaveLength(1);
  });
});
