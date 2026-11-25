import express from "express";
import request from "supertest";
import { createLogger } from "./logging";
import { createTraceMiddleware, resolveRequestId } from "./trace-middleware";

function buildApp() {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    service: "test-indexer",
    sink: (line) => lines.push(line),
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  const app = express();
  app.use(createTraceMiddleware(logger));
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const records = (): Array<Record<string, unknown>> =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  return { app, records };
}

describe("createTraceMiddleware", () => {
  it("continues an inbound trace and logs one JSON request line", async () => {
    const { app, records } = buildApp();
    const inboundTrace =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    const response = await request(app)
      .get("/health?token=should-not-be-logged")
      .set("traceparent", inboundTrace)
      .set("x-request-id", "caller-request-1");

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBe("caller-request-1");

    const [version, traceId, spanId, flags] = (
      response.headers["traceparent"] as string
    ).split("-");
    expect(version).toBe("00");
    expect(traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spanId).not.toBe("00f067aa0ba902b7");
    expect(flags).toBe("01");

    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({
      event: "http_request",
      message: "http_request",
      level: "info",
      service: "test-indexer",
      method: "GET",
      path: "/health",
      status: 200,
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      parent_span_id: "00f067aa0ba902b7",
      request_id: "caller-request-1",
    });
    expect(JSON.stringify(records()[0])).not.toContain("should-not-be-logged");
  });

  it("starts a new trace when the inbound header is invalid", async () => {
    const { app, records } = buildApp();

    const response = await request(app)
      .get("/health")
      .set("traceparent", "garbage")
      .set("x-request-id", "invalid id with spaces");

    const [version, traceId, spanId] = (
      response.headers["traceparent"] as string
    ).split("-");
    expect(version).toBe("00");
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(records()[0]["trace_id"]).toBe(traceId);
    expect(records()[0]["request_id"]).toBe(response.headers["x-request-id"]);
    expect(records()[0]["parent_span_id"]).toBeUndefined();
  });

  it("scopes trace context to the request", async () => {
    const { app, records } = buildApp();

    await request(app).get("/health").set("x-request-id", "one");
    await request(app).get("/health").set("x-request-id", "two");

    expect(records()).toHaveLength(2);
    expect(records()[0]["request_id"]).toBe("one");
    expect(records()[1]["request_id"]).toBe("two");
    expect(records()[0]["trace_id"]).not.toBe(records()[1]["trace_id"]);
  });
});

describe("resolveRequestId", () => {
  it("keeps well-formed inbound ids and replaces bad ones", () => {
    expect(resolveRequestId("abc_123-XYZ")).toBe("abc_123-XYZ");
    expect(resolveRequestId("bad id")).toMatch(/^[0-9a-f]{32}$/);
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f]{32}$/);
  });
});
