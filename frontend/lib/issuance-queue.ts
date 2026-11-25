// frontend/lib/issuance-queue.ts
//
// Admin view over asynchronous issuance callbacks (#850). Reads the webhook
// reconciliation cache and overlays operator state (retry count, resolution).
// In-memory like the cache it wraps: a server restart clears both.

import {
  getIssuanceCallback,
  listIssuanceCallbacks,
  recordIssuanceCallback,
  type NormalizedIssuanceEvent,
  type WebhookIssuanceStatus,
} from "./webhooks";

export type QueueStatusFilter = "all" | "pending" | "failed" | "resolved";

export interface IssuanceQueueRecord {
  eventId: string;
  provider: string;
  credentialType: string;
  status: WebhookIssuanceStatus;
  error?: string;
  timestamp: number;
  retryCount: number;
  lastRetryAt?: number;
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface QueueFilters {
  status?: QueueStatusFilter;
  provider?: string;
  search?: string;
}

interface OperatorState {
  retryCount: number;
  lastRetryAt?: number;
  resolvedAt?: number;
  resolvedBy?: string;
}

const operatorState = new Map<string, OperatorState>();

function toRecord(e: NormalizedIssuanceEvent): IssuanceQueueRecord {
  const s = operatorState.get(e.eventId);
  return {
    eventId: e.eventId,
    provider: String(e.provider),
    credentialType: e.credentialType,
    status: e.status,
    error: e.error,
    timestamp: e.timestamp,
    retryCount: s?.retryCount ?? 0,
    lastRetryAt: s?.lastRetryAt,
    resolvedAt: s?.resolvedAt,
    resolvedBy: s?.resolvedBy,
  };
}

/** Pending + failed + manually resolved records; completed events are not queue items. */
export function listIssuanceQueue(filters: QueueFilters = {}): IssuanceQueueRecord[] {
  const status = filters.status ?? "all";
  const search = filters.search?.trim().toLowerCase();
  return listIssuanceCallbacks()
    .map(toRecord)
    .filter((r) => (r.status === "completed" ? r.resolvedAt !== undefined : true))
    .filter((r) => {
      if (status === "all") return true;
      if (status === "resolved") return r.resolvedAt !== undefined;
      return r.resolvedAt === undefined && r.status === status;
    })
    .filter((r) => !filters.provider || r.provider === filters.provider)
    .filter(
      (r) =>
        !search ||
        r.eventId.toLowerCase().includes(search) ||
        r.credentialType.toLowerCase().includes(search),
    )
    .sort((a, b) => b.timestamp - a.timestamp);
}

export type QueueActionResult =
  | { ok: true; record: IssuanceQueueRecord }
  | { ok: false; error: string; code: "not_found" | "already_resolved" };

/** Re-queue a failed/pending record: bumps the retry counter and resets it to pending. */
export function retryIssuance(eventId: string, now = Date.now()): QueueActionResult {
  const event = getIssuanceCallback(eventId);
  if (!event) return { ok: false, error: "issuance record not found", code: "not_found" };
  const state = operatorState.get(eventId) ?? { retryCount: 0 };
  if (state.resolvedAt !== undefined) {
    return { ok: false, error: "record already resolved", code: "already_resolved" };
  }
  operatorState.set(eventId, { ...state, retryCount: state.retryCount + 1, lastRetryAt: now });
  recordIssuanceCallback({ ...event, status: "pending", error: undefined });
  return { ok: true, record: toRecord(getIssuanceCallback(eventId)!) };
}

/** Mark a record handled out-of-band so it leaves the active queue. */
export function resolveIssuance(
  eventId: string,
  resolvedBy: string,
  now = Date.now(),
): QueueActionResult {
  const event = getIssuanceCallback(eventId);
  if (!event) return { ok: false, error: "issuance record not found", code: "not_found" };
  const state = operatorState.get(eventId) ?? { retryCount: 0 };
  if (state.resolvedAt !== undefined) {
    return { ok: false, error: "record already resolved", code: "already_resolved" };
  }
  operatorState.set(eventId, { ...state, resolvedAt: now, resolvedBy });
  return { ok: true, record: toRecord(event) };
}

export function clearIssuanceQueueState(): void {
  operatorState.clear();
}
