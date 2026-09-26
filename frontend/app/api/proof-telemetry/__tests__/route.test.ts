// @vitest-environment node
//
// Coverage for POST /api/proof-telemetry (frontend/app/api/proof-telemetry/route.ts).
// The endpoint aggregates ONLY coarsely-anonymized timing numbers: it must
// accept valid runs, reject malformed/oversized payloads, and never store
// (or echo back) anything resembling identity data.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// The route keeps its aggregates in a module-scoped map (by design — it's a
// lightweight in-process counter). Re-import the module per test so aggregates
// don't leak across cases.
let POST: (req: NextRequest) => Promise<Response>;

beforeEach(async () => {
  vi.resetModules();
  ({ POST } = await import("../route"));
});

function post(body: unknown) {
  return new NextRequest("http://localhost/api/proof-telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_RUNS = [
  {
    credentialType: "kyc",
    deviceClass: "high",
    timeToFirstProofMs: 30_000,
    exceededBudget: false,
    warm: false,
    stages: [
      { stage: "witness", durationMs: 5_000, overBudget: false },
      { stage: "prove", durationMs: 25_000, overBudget: false },
    ],
  },
  {
    credentialType: "age",
    deviceClass: "high",
    timeToFirstProofMs: 12_000,
    warm: true,
    exceededBudget: false,
    stages: [
      { stage: "witness", durationMs: 2_000, overBudget: false },
      { stage: "prove", durationMs: 10_000, overBudget: false },
    ],
  },
];

describe("POST /api/proof-telemetry", () => {
  it("accepts anonymized runs and returns coarse aggregates", async () => {
    const res = await POST(post({ runs: VALID_RUNS }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.received).toBe(2);
    expect(body.aggregates["high"]).toBeDefined();
    expect(body.aggregates["high"].count).toBe(2);
    // avg time-to-first-proof = (30000 + 12000) / 2
    expect(body.aggregates["high"].timeToFirstProofAvgMs).toBe(21_000);
    expect(body.aggregates["high"].timeToFirstProofMinMs).toBe(12_000);
    expect(body.aggregates["high"].timeToFirstProofMaxMs).toBe(30_000);
    expect(body.aggregates["high"].warmCount).toBe(1);
  });

  it("aggregates across device classes separately", async () => {
    const runs = [
      { ...VALID_RUNS[0], deviceClass: "mid" },
      { ...VALID_RUNS[1], deviceClass: "high" },
    ];
    const res = await POST(post({ runs }));
    const body = await res.json();
    expect(body.received).toBe(2);
    expect(body.aggregates["mid"].count).toBe(1);
    expect(body.aggregates["high"].count).toBe(1);
  });

  it("rejects a payload that is not a { runs: [...] } shape", async () => {
    expect((await POST(post({ foo: 1 }))).status).toBe(400);
    expect((await POST(post({ runs: "nope" }))).status).toBe(400);
    // absently: an array of junk is still 200 but receives zero valid runs.
  });

  it("rejects batches larger than the max", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      credentialType: "kyc",
      deviceClass: "low",
      timeToFirstProofMs: 1000 + i,
      stages: [],
    }));
    expect((await POST(post({ runs: many }))).status).toBe(413);
  });

  it("counts only structurally valid runs and ignores unknown/PII fields", async () => {
    const runs = [
      // Valid — but with a PII-ish extra field that must not leak anywhere.
      { ...VALID_RUNS[0], wallet: "GAAAAAAAA...", commitment: "0xabc" },
      // Invalid (non-finite timing) — must not be counted.
      { ...VALID_RUNS[1], timeToFirstProofMs: "NaN" },
      // Structurally bad stage — dropped, not fatal.
      { ...VALID_RUNS[1], stages: [{ stage: "not-a-stage", durationMs: 5 }] },
    ];
    const res = await POST(post({ runs }));
    const body = await res.json();

    // 1 fully valid + 1 whose stages are dropped (time is finite) = 2 received.
    expect(body.received).toBe(2);
    // The extra fields are never echoed back.
    const text = JSON.stringify(body);
    expect(text).not.toContain("GAAAAAAAA");
    expect(text).not.toContain("0xabc");
    expect(text).not.toContain("wallet");
  });

  it("rejects malformed JSON", async () => {
    const req = new NextRequest("http://localhost/api/proof-telemetry", {
      method: "POST",
      body: "{not-json",
    });
    expect((await POST(req)).status).toBe(400);
  });
});