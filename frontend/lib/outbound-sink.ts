/**
 * Shared, best-effort delivery for server-side outbound data.
 *
 * Telemetry, audit notifications, and error reports all pass through this
 * queue.  The queue is deliberately bounded: an unavailable destination can
 * never make an API request wait indefinitely, and drops are exposed through
 * `outboundSinkStats()` for health/metrics endpoints.
 */

import { logger, stripSensitiveFields } from "./logger";

export type OutboundKind = "telemetry" | "audit" | "error";

export interface OutboundEvent {
  kind: OutboundKind;
  payload: unknown;
}

export interface OutboundSinkStats {
  queued: number;
  delivered: number;
  dropped: number;
  failed: number;
}

const DEFAULT_QUEUE_SIZE = 256;
const MAX_QUEUE_SIZE = 10_000;
const DELIVERY_TIMEOUT_MS = 5_000;

const TELEMETRY_KEYS = new Set([
  "credentialType",
  "deviceClass",
  "cores",
  "memoryGB",
  "timeToFirstProofMs",
  "totalMs",
  "exceededBudget",
  "warm",
  "stages",
]);
const STAGE_KEYS = new Set(["stage", "durationMs", "overBudget"]);
const AUDIT_KEYS = new Set([
  "index",
  "timestamp",
  "requestId",
  "issuer",
  "commitment",
  "prevHash",
  "hash",
]);
const ERROR_KEYS = new Set([
  "timestamp",
  "method",
  "path",
  "requestId",
  "status",
  "environment",
  "error",
]);

function boundedString(value: string): string {
  return value.slice(0, 256);
}

function redactRecord(
  value: Record<string, unknown>,
  allowed: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (typeof item === "string") result[key] = boundedString(item);
    else if (typeof item === "number" || typeof item === "boolean") result[key] = item;
    else if (Array.isArray(item) && key === "stages") {
      result[key] = item
        .filter((stage): stage is Record<string, unknown> =>
          typeof stage === "object" && stage !== null && !Array.isArray(stage),
        )
        .map((stage) => redactRecord(stage, STAGE_KEYS));
    }
  }
  return result;
}

/** The single redaction boundary used by every outbound path. */
export function redactOutboundEvent(event: OutboundEvent): OutboundEvent {
  const payload = event.payload;
  if (event.kind === "telemetry" && typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    const runs = Array.isArray(record.runs)
      ? record.runs
          .filter((run): run is Record<string, unknown> =>
            typeof run === "object" && run !== null && !Array.isArray(run),
          )
          .map((run) => redactRecord(run, TELEMETRY_KEYS))
      : [];
    return { kind: event.kind, payload: { runs } };
  }
  const allowed = event.kind === "audit" ? AUDIT_KEYS : ERROR_KEYS;
  return {
    kind: event.kind,
    payload:
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? redactRecord(payload as Record<string, unknown>, allowed)
        : {},
  };
}

type Delivery = (event: OutboundEvent) => Promise<void>;

interface QueueItem {
  event: OutboundEvent;
  delivery: Delivery;
  settled?: (error?: unknown) => void;
}

export class OutboundSink {
  private readonly maxQueue: number;
  private queue: QueueItem[] = [];
  private active = 0;
  private draining: Promise<void> | null = null;
  private stats: OutboundSinkStats = { queued: 0, delivered: 0, dropped: 0, failed: 0 };

  constructor(maxQueue = queueSizeFromEnv()) {
    this.maxQueue = maxQueue;
  }

  enqueue(event: OutboundEvent, delivery: Delivery = deliverToConfiguredSink): boolean {
    if (this.queue.length + this.active >= this.maxQueue) {
      this.stats.dropped += 1;
      logger.warn(stripSensitiveFields({ event: "outbound_sink_dropped", kind: event.kind }));
      return false;
    }
    this.queue.push({ event: redactOutboundEvent(event), delivery });
    this.stats.queued += 1;
    this.startDrain();
    return true;
  }

  /** Queue work while allowing callers to observe completion without making
   * the request handler await it. */
  enqueueAndWait(
    event: OutboundEvent,
    delivery: Delivery = deliverToConfiguredSink,
  ): Promise<void> {
    return new Promise((resolve) => {
      if (this.queue.length + this.active >= this.maxQueue) {
        this.stats.dropped += 1;
        resolve();
        return;
      }
      this.queue.push({
        event: redactOutboundEvent(event),
        delivery,
        settled: () => resolve(),
      });
      this.stats.queued += 1;
      this.startDrain();
    });
  }

  snapshot(): OutboundSinkStats {
    return { ...this.stats };
  }

  async flush(): Promise<void> {
    await this.draining;
  }

  private startDrain(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.queue.length > 0) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) continue;
      this.active += 1;
      try {
        await item.delivery(item.event);
        this.stats.delivered += 1;
        item.settled?.();
      } catch (error) {
        this.stats.failed += 1;
        item.settled?.(error);
        logger.warn(
          stripSensitiveFields({
            event: "outbound_sink_failed",
            kind: item.event.kind,
            error: error instanceof Error ? error.message : "delivery failed",
          }),
        );
      } finally {
        this.active -= 1;
      }
    }
  }
}

function queueSizeFromEnv(): number {
  const parsed = Number(process.env.OUTBOUND_SINK_QUEUE_SIZE ?? DEFAULT_QUEUE_SIZE);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_QUEUE_SIZE)
    : DEFAULT_QUEUE_SIZE;
}

async function deliverToConfiguredSink(event: OutboundEvent): Promise<void> {
  // ERROR_REPORTING_WEBHOOK remains a compatibility alias while operators
  // migrate to the single shared destination.
  const destination = process.env.OUTBOUND_SINK_URL ?? process.env.ERROR_REPORTING_WEBHOOK;
  if (!destination) return;
  const response = await fetch(destination, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event.payload),
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`sink returned HTTP ${response.status}`);
}

let singleton: OutboundSink | undefined;

export function getOutboundSink(): OutboundSink {
  return (singleton ??= new OutboundSink());
}

export function enqueueOutboundEvent(event: OutboundEvent): boolean {
  return getOutboundSink().enqueue(event);
}

export function outboundSinkStats(): OutboundSinkStats {
  return getOutboundSink().snapshot();
}

export function resetOutboundSinkForTests(): void {
  singleton = undefined;
}
