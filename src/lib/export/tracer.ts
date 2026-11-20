/**
 * Export Observability - Distributed Tracing
 *
 * Provides lightweight, OpenTelemetry-compatible tracing for long-running
 * export jobs, child stages, and storage operations.
 */

import crypto from 'crypto';

export type SpanStatus = 'unset' | 'ok' | 'error';

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export class Span {
  public readonly traceId: string;
  public readonly spanId: string;
  public readonly parentSpanId?: string;
  public readonly name: string;
  public readonly startTime: number;
  public endTime?: number;
  public durationMs?: number;
  public status: SpanStatus = 'unset';
  public statusMessage?: string;
  public attributes: Record<string, string | number | boolean> = {};
  public events: SpanEvent[] = [];
  private onEnd?: (span: Span) => void;

  constructor(
    name: string,
    traceId: string,
    parentSpanId?: string,
    attributes?: Record<string, string | number | boolean>,
    onEnd?: (span: Span) => void
  ) {
    this.name = name;
    this.traceId = traceId;
    this.spanId = crypto.randomBytes(8).toString('hex');
    this.parentSpanId = parentSpanId;
    this.startTime = Date.now();
    if (attributes) {
      this.attributes = { ...attributes };
    }
    this.onEnd = onEnd;
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Record<string, string | number | boolean>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  addEvent(name: string, attributes?: Record<string, string | number | boolean>): this {
    this.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    });
    return this;
  }

  setStatus(status: SpanStatus, message?: string): this {
    this.status = status;
    if (message) {
      this.statusMessage = message;
    }
    return this;
  }

  recordException(error: Error | unknown): this {
    this.status = 'error';
    const message = error instanceof Error ? error.message : String(error);
    this.statusMessage = message;
    this.addEvent('exception', {
      'exception.type': error instanceof Error ? error.name : 'UnknownError',
      'exception.message': message,
      'exception.stack': error instanceof Error && error.stack ? error.stack.slice(0, 500) : '',
    });
    return this;
  }

  end(endTime?: number): SpanData {
    if (!this.endTime) {
      this.endTime = endTime || Date.now();
      if (this.durationMs === undefined) {
        this.durationMs = Math.max(0, this.endTime - this.startTime);
      }
      if (this.status === 'unset') {
        this.status = 'ok';
      }
      if (this.onEnd) {
        this.onEnd(this);
      }
    }
    return this.toJSON();
  }

  toJSON(): SpanData {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: this.durationMs,
      status: this.status,
      statusMessage: this.statusMessage,
      attributes: { ...this.attributes },
      events: [...this.events],
    };
  }
}

export interface TraceRecord {
  traceId: string;
  rootSpanName: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: SpanStatus;
  spans: SpanData[];
}

export class ExportTracer {
  private maxTraces: number;
  private traces: Map<string, TraceRecord> = new Map();

  constructor(maxTraces = 1000) {
    this.maxTraces = maxTraces;
  }

  /**
   * Starts a new root trace with a unique trace ID.
   */
  startTrace(name: string, attributes?: Record<string, string | number | boolean>): Span {
    const traceId = crypto.randomBytes(16).toString('hex');
    const rootSpan = new Span(name, traceId, undefined, attributes, (span) => {
      this.recordSpan(span);
    });

    this.traces.set(traceId, {
      traceId,
      rootSpanName: name,
      startTime: rootSpan.startTime,
      status: 'unset',
      spans: [],
    });

    this.enforceCapacity();
    return rootSpan;
  }

  /**
   * Starts a child span within an existing trace.
   */
  startSpan(
    name: string,
    parent: Span | { traceId: string; spanId: string },
    attributes?: Record<string, string | number | boolean>
  ): Span {
    const traceId = parent.traceId;
    const parentSpanId = 'spanId' in parent ? parent.spanId : undefined;

    return new Span(name, traceId, parentSpanId, attributes, (span) => {
      this.recordSpan(span);
    });
  }

  /**
   * Automatically executes an async or sync function wrapped within a span.
   */
  async withSpan<T>(
    name: string,
    parentOrAttrs: Span | Record<string, string | number | boolean> | undefined,
    fn: (span: Span) => Promise<T> | T,
    attrs?: Record<string, string | number | boolean>
  ): Promise<T> {
    let span: Span;
    if (parentOrAttrs instanceof Span) {
      span = this.startSpan(name, parentOrAttrs, attrs);
    } else {
      const attributes = parentOrAttrs || attrs;
      span = this.startTrace(name, attributes);
    }

    try {
      const result = await fn(span);
      span.setStatus('ok');
      return result;
    } catch (err) {
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  }

  private recordSpan(span: Span): void {
    const trace = this.traces.get(span.traceId);
    if (!trace) return;

    trace.spans.push(span.toJSON());

    // If this is the root span, finalize the overall trace record
    if (!span.parentSpanId) {
      trace.endTime = span.endTime;
      trace.durationMs = span.durationMs;
      trace.status = span.status;
    } else if (span.status === 'error') {
      trace.status = 'error';
    }
  }

  private enforceCapacity(): void {
    if (this.traces.size > this.maxTraces) {
      const oldestKey = this.traces.keys().next().value;
      if (oldestKey) {
        this.traces.delete(oldestKey);
      }
    }
  }

  getTrace(traceId: string): TraceRecord | undefined {
    return this.traces.get(traceId);
  }

  getAllTraces(): TraceRecord[] {
    return Array.from(this.traces.values());
  }

  getRecentTraces(limit = 50): TraceRecord[] {
    return Array.from(this.traces.values())
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }

  getSlowTraces(minDurationMs: number, limit = 50): TraceRecord[] {
    return Array.from(this.traces.values())
      .filter((t) => (t.durationMs || 0) >= minDurationMs)
      .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0))
      .slice(0, limit);
  }

  getErrorTraces(limit = 50): TraceRecord[] {
    return Array.from(this.traces.values())
      .filter((t) => t.status === 'error')
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, limit);
  }

  clear(): void {
    this.traces.clear();
  }
}

export const defaultTracer = new ExportTracer();
