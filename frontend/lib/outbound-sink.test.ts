import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  OutboundSink,
  redactOutboundEvent,
  resetOutboundSinkForTests,
} from "./outbound-sink";

describe("outbound sink", () => {
  beforeEach(() => {
    resetOutboundSinkForTests();
    delete process.env.OUTBOUND_SINK_URL;
    delete process.env.ERROR_REPORTING_WEBHOOK;
  });

  it("uses one redaction boundary for every event kind", () => {
    const telemetry = redactOutboundEvent({
      kind: "telemetry",
      payload: {
        runs: [{
          deviceClass: "mid",
          timeToFirstProofMs: 10,
          wallet: "GPII-MUST-NOT-LEAK",
          stages: [{ stage: "prove", durationMs: 9, secret: "drop" }],
        }],
      },
    });
    expect(JSON.stringify(telemetry)).not.toContain("GPII-MUST-NOT-LEAK");
    expect(JSON.stringify(telemetry)).not.toContain("secret");
    expect(telemetry).toEqual({
      kind: "telemetry",
      payload: {
        runs: [{
          deviceClass: "mid",
          timeToFirstProofMs: 10,
          stages: [{ stage: "prove", durationMs: 9 }],
        }],
      },
    });

    const audit = redactOutboundEvent({
      kind: "audit",
      payload: { index: 0, hash: "abc", first_name: "Alice" },
    });
    expect(audit).toEqual({ kind: "audit", payload: { index: 0, hash: "abc" } });
  });

  it("bounds the queue and reports drops without blocking", () => {
    const sink = new OutboundSink(1);
    let release!: () => void;
    const delivery = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    expect(sink.enqueue({ kind: "error", payload: { status: 500 } }, delivery)).toBe(true);
    expect(sink.enqueue({ kind: "error", payload: { status: 500 } }, delivery)).toBe(false);
    expect(sink.snapshot().dropped).toBe(1);
    release();
  });

  it("delivers queued events and exposes failures as metrics", async () => {
    const sink = new OutboundSink(4);
    const delivery = vi.fn(async () => undefined);
    sink.enqueue({ kind: "error", payload: { status: 500 } }, delivery);
    await sink.flush();
    expect(delivery).toHaveBeenCalledOnce();
    expect(sink.snapshot()).toMatchObject({ queued: 1, delivered: 1, failed: 0 });
  });
});
