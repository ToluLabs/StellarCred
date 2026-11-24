/**
 * trace-context.ts — W3C Trace Context for the API middleware.
 *
 * The same `trace_id` / `span_id` pair an OpenTelemetry-instrumented caller
 * emits is parsed from the inbound `traceparent` header and written onto the
 * structured `api_request` log line, so API logs can be joined to the caller's
 * trace in Jaeger/Datadog. This module is deliberately dependency-free and uses
 * Web Crypto only, because middleware runs on the edge runtime.
 */

export interface TraceContext {
  /** 32 lowercase hex characters, shared by the whole trace. */
  traceId: string;
  /** 16 lowercase hex characters, unique to this hop. */
  spanId: string;
  /** The caller's span id, when this hop continues its trace. */
  parentSpanId?: string;
  /** W3C trace flags; `1` means sampled. */
  traceFlags: number;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(buffer);
  } else {
    for (let i = 0; i < bytes; i += 1) {
      buffer[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Parses an inbound `traceparent`, rejecting malformed or all-zero ids. */
export function parseTraceparent(
  header: string | null | undefined,
): Pick<TraceContext, "traceId" | "spanId" | "traceFlags"> | null {
  if (!header) return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) return null;
  const [, version, traceId, spanId, flags] = match;
  if (version === "ff") return null;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null;
  return { traceId, spanId, traceFlags: parseInt(flags, 16) };
}

/** Continues an inbound trace, or starts a new one when it is unusable. */
export function createTraceContext(inboundTraceparent: string | null | undefined): TraceContext {
  const parent = parseTraceparent(inboundTraceparent);
  return {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    parentSpanId: parent?.spanId,
    traceFlags: parent?.traceFlags ?? 1,
  };
}

/** Serialises the context as a W3C `traceparent` header value. */
export function formatTraceparent(context: TraceContext): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}
