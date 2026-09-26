"use client";

// Self-serve rate-limit & quota dashboard for issuers (see GitHub #424).
//
// Polls the read-only /api/usage endpoint (which, in turn, derives from the
// in-process rate-limit store in lib/rate-limit.ts) and renders the caller's
// current standing: issuance volume used in the window, remaining quota, and a
// live countdown to the exact moment the window resets. When it exhausts a
// dimension it surfaces a prominent, clearly-worded throttled message with the
// reset timing — the two things the issue's acceptance criteria call out:
//"an issuer can see their usage and rate-limit status" and "throttling is
// clearly explained with reset timing".
//
// The endpoint records nothing when polled, so this dashboard can be left open
// or refreshed arbitrarily without ever consuming quota.
//
// `wallet` is optional; when present the wallet dimension for that address is
// shown alongside the IP dimension. No identity data is rendered — only the
// scalar counters the endpoint returns.

import { useCallback, useEffect, useState } from "react";
import {
  IconAlertTriangle,
  IconCpu,
  IconGauge,
  IconRefresh,
  IconWallet,
} from "@tabler/icons-react";

export interface UsageDimension {
  used: number;
  limit: number;
  remaining: number;
  throttled: boolean;
  resetSeconds: number;
  windowEnd: number;
}

export interface UsageResponse {
  scope: "self";
  windowSeconds: number;
  limits: { perIp: number; perWallet: number };
  usage: { ip: UsageDimension; wallet?: UsageDimension };
  throttled: boolean;
}

const FALLBACK_DIM: UsageDimension = {
  used: 0,
  limit: 0,
  remaining: 0,
  throttled: false,
  resetSeconds: 0,
  windowEnd: 0,
};

function fmtReset(resetSeconds: number): string {
  if (resetSeconds >= 60) {
    const m = Math.floor(resetSeconds / 60);
    const s = resetSeconds % 60;
    return `${m}m ${s}s`;
  }
  return `${resetSeconds}s`;
}

// A single quota row: label + icon, a proportional usage bar, and the
// used/remaining/reset breakdown. Turns red once the window is exhausted.
function QuotaRow({
  icon,
  label,
  dim,
  windowSeconds,
}: {
  icon: React.ReactNode;
  label: string;
  dim: UsageDimension;
  windowSeconds: number;
}) {
  const pct =
    dim.limit > 0 ? Math.min(100, Math.round((dim.used / dim.limit) * 100)) : 0;
  const exhausted = dim.throttled && dim.limit > 0;

  return (
    <div
      style={{
        padding: "0.65rem 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          gap: "0.75rem",
          marginBottom: "0.4rem",
        }}
      >
        <span className="row" style={{ gap: "0.45rem", fontSize: "0.8rem", minWidth: 0 }}>
          <span style={{ color: "var(--faint)" }}>{icon}</span>
          <span style={{ fontWeight: 600 }}>{label}</span>
        </span>
        <span className="mono" style={{ fontSize: "0.7rem", color: "var(--faint)" }}>
          used <strong style={{ color: exhausted ? "var(--danger)" : "var(--text)" }}>{dim.used}</strong> / {dim.limit}
        </span>
      </div>

      <div
        style={{
          height: "5px",
          borderRadius: "999px",
          background: "var(--bg-soft)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: "999px",
            background: exhausted
              ? "var(--danger)"
              : pct >= 80
                ? "var(--warn)"
                : "var(--accent)",
            transition: "width 0.4s var(--ease)",
          }}
        />
      </div>

      <div
        className="row faint"
        style={{
          justifyContent: "space-between",
          fontSize: "0.7rem",
          marginTop: "0.35rem",
        }}
      >
        <span>{exhausted ? "Limit reached — new issuances rejected" : `${dim.remaining} of ${dim.limit} remaining`}</span>
        <span className="mono">
          resets in <strong>{fmtReset(dim.resetSeconds)}</strong> · {windowSeconds}s window
        </span>
      </div>
    </div>
  );
}

export function UsageDashboard({ wallet }: { wallet?: string }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Tick state just forces a re-render once a second so the countdown moves.
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = wallet && wallet.trim()
        ? `?wallet=${encodeURIComponent(wallet.trim())}`
        : "";
      const res = await fetch(`/api/usage${qs}`);
      const body = (await res.json()) as Partial<UsageResponse> & { error?: string };
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setUsage(body as UsageResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const ipDim: UsageDimension = usage?.usage.ip ?? FALLBACK_DIM;
  const walletDim: UsageDimension | undefined = usage?.usage.wallet;
  const throttled = usage?.throttled ?? false;
  const windowSeconds = usage?.windowSeconds ?? 60;

  return (
    <div className="card" style={{ padding: "1.15rem 1.25rem" }}>
      <div
        className="between"
        style={{ marginBottom: "0.35rem", gap: "0.75rem" }}
      >
        <span className="row" style={{ gap: "0.5rem" }}>
          <IconGauge size={15} style={{ color: "var(--accent)" }} />
          <strong style={{ fontSize: "0.85rem" }}>Rate-limit &amp; quota</strong>
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={load}
          disabled={loading}
          title={error ? "Retry" : "Refresh"}
        >
          <IconRefresh size={13} className={loading ? "spin" : undefined} />
          {loading ? "Loading" : "Refresh"}
        </button>
      </div>

      {throttled && (
        <div
          role="alert"
          style={{
            margin: "0.6rem 0 0.4rem",
            padding: "0.6rem 0.8rem",
            borderRadius: "var(--radius)",
            border: "1px solid rgba(240,96,77,0.35)",
            background: "rgba(240,96,77,0.08)",
          }}
        >
          <div
            className="row"
            style={{ gap: "0.45rem", color: "var(--danger)", fontWeight: 600, fontSize: "0.8rem" }}
          >
            <IconAlertTriangle size={14} />
            Rate limit reached
          </div>
          <div style={{ fontSize: "0.78rem", marginTop: "0.25rem", lineHeight: 1.6, color: "var(--muted)" }}>
            Issuance is temporarily paused. The window resets in{" "}
            <strong className="mono" style={{ color: "var(--text)" }}>
              {fmtReset(Math.max(ipDim.resetSeconds, walletDim?.resetSeconds ?? 0))}
            </strong>
            {" "}— you can resume then.
          </div>
        </div>
      )}

      {error && (
        <p
          style={{
            fontSize: "0.78rem",
            color: "var(--danger)",
            margin: "0.5rem 0",
          }}
        >
          Could not load usage: {error}
        </p>
      )}

      {!usage && !error && (
        <div style={{ padding: "0.5rem 0", fontSize: "0.8rem", color: "var(--faint)" }}>
          Computing your usage… (derived from the rate-limit store; nothing is recorded)
        </div>
      )}

      {usage && (
        <div style={{ marginTop: "0.4rem" }}>
          <QuotaRow
            icon={<IconCpu size={13} />}
            label="This connection (IP)"
            dim={ipDim}
            windowSeconds={windowSeconds}
          />
          {walletDim ? (
            <QuotaRow
              icon={<IconWallet size={13} />}
              label={`Holder wallet usage`}
              dim={walletDim}
              windowSeconds={windowSeconds}
            />
          ) : (
            <div className="faint" style={{ fontSize: "0.7rem", padding: "0.5rem 0 0.15rem" }}>
              <IconWallet size={11} style={{ marginRight: "0.3rem" }} />
              Add a holder&apos;s address in the form above to see their per-wallet usage here.
            </div>
          )}

          <div className="faint" style={{ fontSize: "0.68rem", marginTop: "0.35rem", lineHeight: 1.6 }}>
            Usage is per connection and per holder wallet over a {windowSeconds}-second
            window. Polling this view never counts against your limits.
          </div>
        </div>
      )}
    </div>
  );
}