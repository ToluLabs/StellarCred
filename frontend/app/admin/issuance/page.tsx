/**
 * Admin issuance queue (#850) — Server Component.
 *
 * Lists pending/failed issuance callbacks with filters and retry/resolve
 * actions. Gated server-side by ADMIN_API_KEY (Bearer header or the httpOnly
 * session cookie set via the login form); unauthenticated visitors only see
 * the login form and no queue data is rendered or serialized.
 */

import { isAdminPageAuthorized } from "@/lib/admin-page-auth";
import { listIssuanceQueue, type QueueStatusFilter } from "@/lib/issuance-queue";
import { loginAction } from "./actions";
import { QueueTable } from "./components/QueueTable";

export const dynamic = "force-dynamic";

const STATUSES: QueueStatusFilter[] = ["all", "pending", "failed", "resolved"];

export default function AdminIssuancePage({
  searchParams,
}: {
  searchParams: { status?: string; provider?: string; q?: string };
}) {
  if (!isAdminPageAuthorized()) {
    return (
      <section aria-labelledby="issuance-login">
        <h2 id="issuance-login">Admin sign-in required</h2>
        <form action={loginAction} style={{ display: "flex", gap: "0.5rem" }}>
          <label>
            Admin key{" "}
            <input name="key" type="password" autoComplete="off" required />
          </label>
          <button type="submit">Sign in</button>
        </form>
      </section>
    );
  }

  const status = STATUSES.includes(searchParams.status as QueueStatusFilter)
    ? (searchParams.status as QueueStatusFilter)
    : "all";
  const records = listIssuanceQueue({
    status,
    provider: searchParams.provider || undefined,
    search: searchParams.q || undefined,
  });

  return (
    <section aria-labelledby="issuance-heading">
      <h2 id="issuance-heading" style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>
        Issuance Queue
      </h2>
      <form method="get" style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <select name="status" defaultValue={status} aria-label="Status">
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input name="provider" placeholder="Provider" defaultValue={searchParams.provider ?? ""} />
        <input name="q" placeholder="Event ID / type" defaultValue={searchParams.q ?? ""} />
        <button type="submit">Filter</button>
      </form>
      <QueueTable initialRecords={records} />
    </section>
  );
}
