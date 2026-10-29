// frontend/lib/admin-api.ts
//
// Typed client for the admin issuance endpoints (#850). Used by external
// tooling (Bearer ADMIN_API_KEY); the web UI uses server actions instead.

import type { IssuanceQueueRecord, QueueFilters } from "@/lib/issuance-queue";

export async function fetchIssuanceQueue(
  adminKey: string,
  filters: QueueFilters = {},
  baseUrl = "",
): Promise<IssuanceQueueRecord[]> {
  const qs = new URLSearchParams();
  if (filters.status) qs.set("status", filters.status);
  if (filters.provider) qs.set("provider", filters.provider);
  if (filters.search) qs.set("search", filters.search);
  const res = await fetch(`${baseUrl}/api/admin/issuance?${qs}`, {
    headers: { Authorization: `Bearer ${adminKey}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`issuance queue request failed: ${res.status}`);
  return ((await res.json()) as { records: IssuanceQueueRecord[] }).records;
}

export async function actOnIssuance(
  adminKey: string,
  eventId: string,
  action: "retry" | "resolve",
  actor: string,
  baseUrl = "",
): Promise<IssuanceQueueRecord> {
  const res = await fetch(`${baseUrl}/api/admin/issuance/${encodeURIComponent(eventId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, actor }),
  });
  const body = (await res.json()) as { record?: IssuanceQueueRecord; error?: string };
  if (!res.ok || !body.record) throw new Error(body.error ?? `request failed: ${res.status}`);
  return body.record;
}
