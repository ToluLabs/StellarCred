/**
 * trace-middleware.ts — per-request trace context for the indexer HTTP API.
 *
 * Mounted before every route so that:
 *
 *   - an inbound W3C `traceparent` continues the caller's trace (new span,
 *     same trace id), and a request without one starts a fresh trace;
 *   - an inbound `x-request-id` is preserved when well-formed, otherwise a
 *     random one is generated;
 *   - every log line written while the route runs carries `trace_id` and
 *     `span_id` automatically;
 *   - the response carries `traceparent` and `x-request-id`, so a caller (or a
 *     reverse proxy) can join its logs to this service's trace;
 *   - exactly one JSON `http_request` line is emitted per request with method,
 *     route path, status and duration — no bodies, headers or query strings.
 */

import type { RequestHandler } from "express";
import {
  formatTraceparent,
  generateRequestId,
  generateSpanId,
  newTraceContext,
  parseTraceparent,
  runWithTraceContext,
  type JsonLogger,
  type TraceContext,
} from "./logging";

const REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Keeps the inbound request id only when it is the shape the API accepts. */
export function resolveRequestId(inbound: string | undefined): string {
  const trimmed = inbound?.trim();
  return trimmed && REQUEST_ID_RE.test(trimmed) ? trimmed : generateRequestId();
}

export function createTraceMiddleware(logger: JsonLogger): RequestHandler {
  return (req, res, next) => {
    const parent = parseTraceparent(firstHeader(req.headers["traceparent"]));
    const requestId = resolveRequestId(firstHeader(req.headers["x-request-id"]));

    const context: TraceContext = parent
      ? {
          traceId: parent.traceId,
          spanId: generateSpanId(),
          parentSpanId: parent.spanId,
          traceFlags: parent.traceFlags,
          requestId,
        }
      : newTraceContext(requestId);

    res.setHeader("traceparent", formatTraceparent(context));
    res.setHeader("x-request-id", requestId);

    const startedAt = process.hrtime.bigint();

    runWithTraceContext(context, () => {
      res.once("finish", () => {
        const durationMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        logger.info("http_request", {
          event: "http_request",
          method: req.method,
          path: (req.originalUrl ?? req.url).split("?")[0],
          status: res.statusCode,
          duration_ms: Math.round(durationMs * 1_000) / 1_000,
        });
      });
      next();
    });
  };
}
