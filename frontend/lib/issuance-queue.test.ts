import { describe, it, expect, beforeEach } from "vitest";
import { clearIssuanceCallbacks, recordIssuanceCallback } from "./webhooks";
import {
  clearIssuanceQueueState,
  listIssuanceQueue,
  resolveIssuance,
  retryIssuance,
} from "./issuance-queue";

const ev = (eventId: string, status: "pending" | "failed" | "completed", provider = "persona") => ({
  eventId,
  provider,
  eventType: "t",
  status,
  credentialType: "kyc",
  timestamp: Date.now(),
  error: status === "failed" ? "boom" : undefined,
});

describe("issuance queue (#850)", () => {
  beforeEach(() => {
    clearIssuanceCallbacks();
    clearIssuanceQueueState();
    recordIssuanceCallback(ev("a", "pending"));
    recordIssuanceCallback(ev("b", "failed", "plaid"));
    recordIssuanceCallback(ev("c", "completed"));
  });

  it("excludes completed events and filters by status/provider/search", () => {
    expect(listIssuanceQueue().map((r) => r.eventId).sort()).toEqual(["a", "b"]);
    expect(listIssuanceQueue({ status: "failed" }).map((r) => r.eventId)).toEqual(["b"]);
    expect(listIssuanceQueue({ provider: "plaid" }).map((r) => r.eventId)).toEqual(["b"]);
    expect(listIssuanceQueue({ search: "A" }).map((r) => r.eventId)).toEqual(["a"]);
  });

  it("retry resets a failed record to pending and counts attempts", () => {
    const r = retryIssuance("b");
    expect(r.ok && r.record.status).toBe("pending");
    expect(r.ok && r.record.error).toBeUndefined();
    const r2 = retryIssuance("b");
    expect(r2.ok && r2.record.retryCount).toBe(2);
  });

  it("resolve removes from active filters and blocks further retries", () => {
    expect(resolveIssuance("a", "admin").ok).toBe(true);
    expect(listIssuanceQueue({ status: "pending" })).toEqual([]);
    expect(listIssuanceQueue({ status: "resolved" }).map((r) => r.eventId)).toEqual(["a"]);
    const again = retryIssuance("a");
    expect(again.ok).toBe(false);
  });

  it("reports unknown ids", () => {
    const r = retryIssuance("nope");
    expect(!r.ok && r.code).toBe("not_found");
  });
});
