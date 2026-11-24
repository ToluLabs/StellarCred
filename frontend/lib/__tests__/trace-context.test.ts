import { describe, expect, it } from "vitest";

import { createTraceContext, formatTraceparent, parseTraceparent } from "../trace-context";

describe("parseTraceparent", () => {
  it("parses a valid header and round-trips it", () => {
    const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const parsed = parseTraceparent(header);
    expect(parsed).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });
    expect(formatTraceparent({ ...parsed!, parentSpanId: undefined })).toBe(header);
  });

  it.each([
    undefined,
    null,
    "",
    "garbage",
    "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
    "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
  ])("rejects invalid header %p", (header) => {
    expect(parseTraceparent(header)).toBeNull();
  });
});

describe("createTraceContext", () => {
  it("continues an inbound trace with a new span", () => {
    const context = createTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

    expect(context.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(context.parentSpanId).toBe("00f067aa0ba902b7");
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(context.spanId).not.toBe("00f067aa0ba902b7");
    expect(context.traceFlags).toBe(1);
    expect(formatTraceparent(context)).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
    );
  });

  it("starts a fresh trace when the header is missing or invalid", () => {
    for (const header of [null, "invalid"]) {
      const context = createTraceContext(header);
      expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(context.parentSpanId).toBeUndefined();
      expect(context.traceFlags).toBe(1);
      expect(context.traceId).not.toBe("00000000000000000000000000000000");
    }
  });
});
