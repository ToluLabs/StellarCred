// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const HOLDER_1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH1";
const HOLDER_2 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH2";
const HOLDER_3 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWH3";
const ISSUER_ID = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

function be32(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
}

vi.mock("@/lib/issuer-registry", () => ({
  fetchIssuerPubkey: vi.fn(),
}));

const ENV_KEYS = [
  "ISSUER_PRIVATE_KEY",
  "NEXT_PUBLIC_ISSUER_REGISTRY_ID",
  "NEXT_PUBLIC_ISSUER_ADDRESS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loadBatchRoute() {
  vi.resetModules();
  return import("../route");
}

function postBatchRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/issue/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/issue/batch", () => {
  it("rejects an empty batch with 400 Bad Request", async () => {
    const { POST } = await loadBatchRoute();
    const res = await POST(postBatchRequest({ items: [] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/at least one item/);
  });

  it("rejects a batch exceeding MAX_BATCH_SIZE (50 items) with 400 Bad Request", async () => {
    const { POST } = await loadBatchRoute();
    const oversizedItems = Array.from({ length: 51 }, (_, i) => ({
      holder: `GHOLDER_${i}`,
      type: "kyc",
      issuerId: ISSUER_ID,
    }));
    const res = await POST(postBatchRequest({ items: oversizedItems }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/exceeds maximum limit/);
  });

  it("successfully issues a batch of valid credentials in one call", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadBatchRoute();

    const res = await POST(
      postBatchRequest({
        issuerId: ISSUER_ID,
        items: [
          { holder: HOLDER_1, type: "kyc" },
          {
            holder: HOLDER_2,
            type: "age",
            attributes: { date_of_birth: "1990-01-01" },
            claimParams: { threshold_years: "21" },
          },
          {
            holder: HOLDER_3,
            type: "income",
            attributes: { income: "300000" },
            claimParams: { threshold: "200000" },
          },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(3);
    expect(data.successful).toBe(3);
    expect(data.failed).toBe(0);
    expect(data.results).toHaveLength(3);

    // Check item 0
    expect(data.results[0].success).toBe(true);
    expect(data.results[0].credentials[0].type).toBe("kyc");
    expect(data.results[0].credentials[0].holder).toBe(HOLDER_1);

    // Verify signature on item 0 with prehash: false
    const cred0 = data.results[0].credentials[0];
    const pubkeyUncompressed = new Uint8Array([
      0x04,
      ...cred0.issuerPubX,
      ...cred0.issuerPubY,
    ]);
    const digest = be32(BigInt(cred0.commitment));
    const sig = Uint8Array.from(cred0.sig);
    expect(secp256k1.verify(sig, digest, pubkeyUncompressed, { prehash: false })).toBe(true);

    // Check item 1
    expect(data.results[1].success).toBe(true);
    expect(data.results[1].credentials[0].type).toBe("age");
    expect(data.results[1].credentials[0].claim).toBe("age ≥ 21");

    // Check item 2
    expect(data.results[2].success).toBe(true);
    expect(data.results[2].credentials[0].type).toBe("income");
  });

  it("handles partial failure without rejecting the whole batch", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadBatchRoute();

    const res = await POST(
      postBatchRequest({
        issuerId: ISSUER_ID,
        items: [
          { holder: HOLDER_1, type: "kyc" },
          { holder: HOLDER_2, type: "invalid_credential_type" },
          { holder: "", type: "age" }, // missing holder
          { holder: HOLDER_3, type: "accreditation", attributes: { net_worth: "1500000" } },
        ],
      }),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(4);
    expect(data.successful).toBe(2);
    expect(data.failed).toBe(2);

    expect(data.results[0].success).toBe(true);
    expect(data.results[0].credentials[0].type).toBe("kyc");

    expect(data.results[1].success).toBe(false);
    expect(data.results[1].error).toMatch(/Invalid credential type/);

    expect(data.results[2].success).toBe(false);
    expect(data.results[2].error).toMatch(/holder address is required/);

    expect(data.results[3].success).toBe(true);
    expect(data.results[3].credentials[0].type).toBe("accreditation");
  });

  it("supports direct array payload", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadBatchRoute();

    const res = await POST(
      postBatchRequest([
        { holder: HOLDER_1, type: "kyc", issuerId: ISSUER_ID },
        { holder: HOLDER_2, type: "age", issuerId: ISSUER_ID, attributes: { date_of_birth: "1995-05-05" } },
      ]),
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.successful).toBe(2);
    expect(data.failed).toBe(0);
  });

  it("replays cached response when Idempotency-Key is provided", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadBatchRoute();

    const idempotencyKey = "batch-key-123456";
    const body = {
      issuerId: ISSUER_ID,
      items: [{ holder: HOLDER_1, type: "kyc" }],
    };

    const res1 = await POST(
      postBatchRequest(body, { "Idempotency-Key": idempotencyKey }),
    );
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-Idempotent")).toBeNull();

    const res2 = await POST(
      postBatchRequest(body, { "Idempotency-Key": idempotencyKey }),
    );
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-Idempotent")).toBe("true");
  });
});
