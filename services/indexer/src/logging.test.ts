import {
  createLogger,
  formatTraceparent,
  getTraceContext,
  injectTraceHeaders,
  newTraceContext,
  parseLogLevel,
  parseTraceparent,
  redactValue,
  runWithTraceContext,
  serializeError,
  withSpan,
} from "./logging";

type LogRecord = Record<string, unknown>;

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    service: "test-service",
    sink: (line) => lines.push(line),
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  const records = (): LogRecord[] =>
    lines.map((line) => JSON.parse(line) as LogRecord);
  return { lines, logger, records };
}

describe("parseTraceparent", () => {
  it("parses a valid W3C header and round-trips it", () => {
    const header =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const parsed = parseTraceparent(header);
    expect(parsed).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });
    expect(formatTraceparent(parsed!)).toBe(header);
  });

  it("accepts future versions with trailing fields", () => {
    const parsed = parseTraceparent(
      "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra"
    );
    expect(parsed?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it.each([
    undefined,
    null,
    "",
    "not-a-traceparent",
    // forbidden version
    "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    // zero trace id
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    // zero span id
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
    // uppercase hex is not valid trace context
    "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
    // truncated id
    "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01",
  ])("rejects invalid header %p", (header) => {
    expect(parseTraceparent(header)).toBeNull();
  });
});

describe("JsonLogger", () => {
  it("emits one JSON line with canonical fields and caller fields", () => {
    const { lines, logger, records } = capture();
    logger.info("database_ready", { db_driver: "sqlite" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(records()[0]).toMatchObject({
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "info",
      message: "database_ready",
      service: "test-service",
      db_driver: "sqlite",
    });
  });

  it("filters below the configured level", () => {
    const { lines } = capture();
    const warnOnly = createLogger({
      level: "warn",
      sink: (line) => lines.push(line),
    });

    warnOnly.debug("ignored");
    warnOnly.info("ignored");
    warnOnly.warn("kept");
    warnOnly.error("kept too");

    expect(lines).toHaveLength(2);
  });

  it("never lets caller fields spoof canonical fields", () => {
    const { logger, records } = capture();
    logger.info("spoof", {
      message: "forged",
      level: "error",
      service: "other",
      timestamp: "1999-01-01T00:00:00.000Z",
    });

    expect(records()[0]).toMatchObject({
      message: "spoof",
      level: "info",
      service: "test-service",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });

  it("merges child fields without mutating the parent", () => {
    const { logger, records } = capture();
    const child = logger.child({ component: "ingester" });
    logger.info("parent");
    child.info("child", { ledger: 42 });

    expect(records()[0]["component"]).toBeUndefined();
    expect(records()[1]).toMatchObject({
      message: "child",
      component: "ingester",
      ledger: 42,
    });
  });

  it("injects trace and span ids from the active context", () => {
    const { logger, records } = capture();
    const context = newTraceContext("request-123");

    runWithTraceContext(context, () => {
      logger.info("inside");
    });
    logger.info("outside");

    expect(records()[0]).toMatchObject({
      message: "inside",
      trace_id: context.traceId,
      span_id: context.spanId,
      trace_flags: 1,
      request_id: "request-123",
    });
    expect(records()[1]["trace_id"]).toBeUndefined();
    expect(records()[1]["span_id"]).toBeUndefined();
  });

  it("redacts secret-bearing fields and serializes errors", () => {
    const { logger, records } = capture();
    logger.error("failed", {
      password: "hunter2",
      nested: { apiKey: "k", webhook_signing_secret: "s", ok: 1 },
      error: new Error("boom"),
    });

    expect(records()[0]).toMatchObject({
      password: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
        webhook_signing_secret: "[REDACTED]",
        ok: 1,
      },
      error: { name: "Error", message: "boom" },
    });
    expect(JSON.stringify(records()[0])).not.toContain("hunter2");
  });
});

describe("redactValue", () => {
  it("replaces circular references instead of throwing", () => {
    const value: Record<string, unknown> = { name: "loop" };
    value["self"] = value;

    expect(redactValue(value)).toEqual({
      name: "loop",
      self: "[CIRCULAR]",
    });
  });

  it("truncates very long strings", () => {
    const result = redactValue("x".repeat(5_000)) as string;
    expect(result.length).toBeLessThan(5_000);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("withSpan", () => {
  it("opens a child span in the same trace and exposes it to logs", async () => {
    const parent = newTraceContext("req-1");
    const { logger, records } = capture();
    let observed: ReturnType<typeof getTraceContext> = undefined;

    await runWithTraceContext(parent, () =>
      withSpan("ingester.tick", async (span) => {
        observed = getTraceContext();
        expect(span.traceId).toBe(parent.traceId);
        expect(span.spanId).not.toBe(parent.spanId);
        expect(span.parentSpanId).toBe(parent.spanId);
        span.setAttribute("events", 3);
        logger.info("tick_work", { events: 3 });
      })
    );

    expect(observed!.traceId).toBe(parent.traceId);
    expect(observed!.spanId).not.toBe(parent.spanId);
    expect(records()[0]).toMatchObject({
      message: "tick_work",
      trace_id: parent.traceId,
      span_id: observed!.spanId,
      request_id: "req-1",
    });
  });

  it("marks the span failed and rethrows the original error", async () => {
    await expect(
      withSpan("failing", () => {
        throw new Error("upstream down");
      })
    ).rejects.toThrow("upstream down");
  });
});

describe("injectTraceHeaders", () => {
  it("adds traceparent only while a trace is active", () => {
    expect(injectTraceHeaders()).toEqual({});

    const context = newTraceContext();
    const headers = runWithTraceContext(context, () =>
      injectTraceHeaders({ accept: "application/json" })
    );

    expect(headers).toEqual({
      accept: "application/json",
      traceparent: formatTraceparent(context),
    });
  });

  it("does not overwrite an explicit traceparent", () => {
    const context = newTraceContext();
    const headers = runWithTraceContext(context, () =>
      injectTraceHeaders({ traceparent: "00-aaaa-1-01" })
    );
    expect(headers["traceparent"]).toBe("00-aaaa-1-01");
  });
});

describe("helpers", () => {
  it("parses log levels defensively", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("bogus")).toBe("info");
    expect(parseLogLevel(" DEBUG ")).toBe("debug");
  });

  it("serializes non-Error throws", () => {
    expect(serializeError("plain failure")).toEqual({
      message: "plain failure",
    });
  });
});
