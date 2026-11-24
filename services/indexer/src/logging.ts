/**
 * logging.ts — one structured JSON log line per event, with OpenTelemetry
 * trace/span correlation.
 *
 * Every backend service writes JSON to stdout so an observability platform
 * (Jaeger, Datadog, Loki, CloudWatch, …) can index fields rather than parse
 * prose. This module is the single logging boundary for the indexer:
 *
 *   - `createLogger()` returns a logger whose `info/warn/error/debug` methods
 *     emit exactly one JSON object per line: `timestamp`, `level`, `message`,
 *     `service`, the active trace context, and caller fields.
 *   - The trace identifiers follow OpenTelemetry / W3C Trace Context: a
 *     32-hex-character `trace_id`, a 16-hex-character `span_id`, and the
 *     `traceparent` header's sampling flags. They are injected automatically
 *     from the async-local context, so any log written while handling a
 *     request, a tick, or an outbound call is correlated with its span without
 *     the call site passing IDs around.
 *   - `withSpan()` opens a child span (same trace, new span, parent id set)
 *     around a unit of work, records its duration and status, and emits a
 *     `span.end` record at debug level. That is the lightweight span model
 *     these logs need; the field names line up with what an OTel exporter
 *     would produce for the same context.
 *   - Field values are redacted at the logging boundary. Keys that could carry
 *     secrets (tokens, private keys, witness data, …) never reach stdout, and
 *     errors are serialized to `{ name, message, stack }` without ever
 *     stringifying arbitrary request bodies.
 *
 * It deliberately has no OpenTelemetry SDK dependency: the service only needs
 * the identifiers and the propagation format, and a self-contained
 * implementation keeps the build small and testable. A real OTel SDK can later
 * read the same `traceparent` values this module emits without a log-format
 * change.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

// ── Levels ─────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Any unrecognised value falls back to `info` rather than silencing logs. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const normalised = value?.trim().toLowerCase();
  if (normalised && normalised in LEVEL_WEIGHTS) {
    return normalised as LogLevel;
  }
  return "info";
}

// ── Trace context (W3C traceparent) ────────────────────────────────────────

/** OpenTelemetry-compatible correlation identifiers for the active span. */
export interface TraceContext {
  /** 32 lowercase hex characters; shared by every span in a trace. */
  traceId: string;
  /** 16 lowercase hex characters; unique to one span. */
  spanId: string;
  /** Set when this span was opened beneath another span. */
  parentSpanId?: string;
  /** W3C trace flags; bit 0 (`01`) means "sampled". */
  traceFlags: number;
  /** HTTP correlation id, when the work originated from a request. */
  requestId?: string;
}

/**
 * W3C traceparent: `version-traceid-spanid-flags`.
 *
 * Version `ff` is forbidden by the specification, and an all-zero trace or
 * span id is invalid. Only lowercase hex is accepted, as the spec requires.
 * Newer versions may append `-…` fields, which are ignored.
 */
const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

/** Parses an inbound `traceparent`, or returns null when it is unusable. */
export function parseTraceparent(
  header: string | null | undefined
): Pick<TraceContext, "traceId" | "spanId" | "traceFlags"> | null {
  if (!header) return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) return null;
  const version = match[1];
  const traceId = match[2];
  const spanId = match[3];
  const flags = match[4];
  if (version === "ff") return null;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null;
  return { traceId, spanId, traceFlags: parseInt(flags, 16) };
}

/** Formats a context as a W3C `traceparent` header value. */
export function formatTraceparent(
  context: Pick<TraceContext, "traceId" | "spanId" | "traceFlags">
): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** A request correlation id in the same shape the API already accepted. */
export function generateRequestId(): string {
  return randomBytes(16).toString("hex");
}

/** Starts a brand-new trace, optionally tied to an HTTP request id. */
export function newTraceContext(requestId?: string): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    traceFlags: 1,
    requestId,
  };
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/** The trace context active in this async execution, if any. */
export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

/** Runs `fn` (and the async work it starts) inside `context`. */
export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

/**
 * Outbound headers that continue the current trace: `traceparent` is added
 * unless the caller already provided one. Returns the input untouched when no
 * trace is active.
 */
export function injectTraceHeaders(
  headers: Record<string, string> = {}
): Record<string, string> {
  const context = getTraceContext();
  if (!context || headers["traceparent"]) return headers;
  return { ...headers, traceparent: formatTraceparent(context) };
}

// ── Spans ──────────────────────────────────────────────────────────────────

export type SpanStatus = "unset" | "ok" | "error";

export interface Span extends TraceContext {
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  error?: Record<string, unknown>;
  setAttribute(key: string, value: unknown): Span;
}

// ── Redaction ──────────────────────────────────────────────────────────────

export type LogFields = Record<string, unknown>;

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const MAX_STRING_LENGTH = 4_000;
const MAX_DEPTH = 6;

/**
 * Keys whose values must never reach a log sink. Matched case-insensitively
 * anywhere in the key, so `authorizationHeader`, `apiKey`, and
 * `webhook_signing_secret` are all caught.
 */
const SENSITIVE_KEY_RE =
  /(password|passphrase|secret|private[_-]?key|api[_-]?key|authorization|cookie|token|salt|witness|mnemonic|seed)/i;

/** Serialises an unknown thrown value into loggable fields. */
export function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    const stack = error.stack
      ?.split("\n")
      .slice(0, 6)
      .join("\n");
    return {
      name: error.name,
      message: error.message,
      ...(stack ? { stack } : {}),
    };
  }
  return { message: String(error) };
}

/**
 * Deep-copies a value into something JSON-safe, redacting secret-bearing keys
 * and cutting circular references. Exported so tests can pin the boundary.
 */
export function redactValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): unknown {
  if (depth > MAX_DEPTH) return TRUNCATED;
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…`
      : value;
  }
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_RE.test(key)
        ? REDACTED
        : redactValue(entry, seen, depth + 1);
    }
    return result;
  }
  return value;
}

function redactFields(fields: LogFields): LogFields {
  return redactValue(fields) as LogFields;
}

// ── Logger ─────────────────────────────────────────────────────────────────

export interface JsonLoggerOptions {
  /** Minimum level to emit. Defaults to `LOG_LEVEL`, then `info`. */
  level?: LogLevel | string;
  /** `service` field on every line. Defaults to `OTEL_SERVICE_NAME`. */
  service?: string;
  /** Fields merged into every line (for example `component: "ingester"`). */
  base?: LogFields;
  /** Where a serialized line goes. Defaults to stdout. Injectable for tests. */
  sink?: (line: string) => void;
  /** Trace-context source. Defaults to the async-local context. */
  context?: () => TraceContext | undefined;
  /** Timestamp source. Injectable for deterministic tests. */
  clock?: () => Date;
}

const defaultSink = (line: string): void => {
  // Keep test output readable; tests that assert on lines inject a sink.
  if (process.env["NODE_ENV"] === "test") return;
  // A closed pipe must never take the service down with it.
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // Ignored: logging is best-effort and must not throw.
  }
};

/**
 * Emits one JSON object per line. Instances are immutable: `child()` returns a
 * new logger sharing the sink, so request-scoped fields cannot leak between
 * concurrent callers.
 */
export class JsonLogger {
  private readonly level: LogLevel;
  private readonly service: string;
  private readonly base: LogFields;
  private readonly sink: (line: string) => void;
  private readonly context: () => TraceContext | undefined;
  private readonly clock: () => Date;

  constructor(options: JsonLoggerOptions = {}) {
    this.level = parseLogLevel(options.level);
    this.service =
      options.service ??
      process.env["OTEL_SERVICE_NAME"] ??
      process.env["SERVICE_NAME"] ??
      "stellarcred-indexer";
    this.base = options.base ?? {};
    this.sink = options.sink ?? defaultSink;
    this.context = options.context ?? getTraceContext;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Derived logger sharing this sink but adding permanent fields. */
  child(fields: LogFields): JsonLogger {
    return new JsonLogger({
      level: this.level,
      service: this.service,
      base: { ...this.base, ...fields },
      sink: this.sink,
      context: this.context,
      clock: this.clock,
    });
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS[this.level];
  }

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (!this.isLevelEnabled(level)) return;

    const record: LogFields = {
      ...redactFields(this.base),
      ...redactFields(fields),
    };

    // Canonical fields are written last so caller fields cannot spoof them.
    record["timestamp"] = this.clock().toISOString();
    record["level"] = level;
    record["message"] = message;
    record["service"] = this.service;

    const context = this.context();
    if (context) {
      record["trace_id"] = context.traceId;
      record["span_id"] = context.spanId;
      record["trace_flags"] = context.traceFlags;
      if (context.parentSpanId) {
        record["parent_span_id"] = context.parentSpanId;
      }
      if (context.requestId) {
        record["request_id"] = context.requestId;
      }
    }

    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (error) {
      line = JSON.stringify({
        timestamp: this.clock().toISOString(),
        level: "error",
        message: "log_serialization_failed",
        service: this.service,
        error: serializeError(error),
      });
    }
    this.sink(line);
  }

  debug(message: string, fields?: LogFields): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.log("error", message, fields);
  }
}

/**
 * Process-wide logger. Modules write through this instance; request handlers
 * and spans only add context, never replace it.
 */
export const logger = new JsonLogger({
  service: process.env["OTEL_SERVICE_NAME"] ?? "stellarcred-indexer",
});

export function createLogger(options: JsonLoggerOptions = {}): JsonLogger {
  return new JsonLogger(options);
}

// ── Span helpers ───────────────────────────────────────────────────────────

/**
 * Runs `fn` in a child span of the active trace (or a new trace when none is
 * active). The span is recorded once it ends, and its context makes every log
 * line written inside `fn` carry the span's identifiers.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes: LogFields = {}
): Promise<T> {
  const parent = getTraceContext();
  const span: Span = {
    traceId: parent?.traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    parentSpanId: parent?.spanId,
    traceFlags: parent?.traceFlags ?? 1,
    requestId: parent?.requestId,
    name,
    startTime: Date.now(),
    status: "unset",
    attributes: { ...attributes },
    setAttribute(key: string, value: unknown): Span {
      span.attributes[key] = value;
      return span;
    },
  };

  return runWithTraceContext(span, async () => {
    try {
      const result = await fn(span);
      span.status = "ok";
      return result;
    } catch (error) {
      span.status = "error";
      span.error = serializeError(error);
      throw error;
    } finally {
      span.endTime = Date.now();
      span.durationMs = span.endTime - span.startTime;
      logger.debug("span.end", {
        event: "span.end",
        span_name: span.name,
        duration_ms: span.durationMs,
        status: span.status,
        attributes: span.attributes,
        ...(span.error ? { error: span.error } : {}),
      });
    }
  });
}
