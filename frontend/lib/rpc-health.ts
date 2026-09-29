"use client";

/**
 * App-level Soroban RPC health (Issue #634 — explicit degraded mode).
 *
 * The SDK already retries individual reads with a timeout, but nothing in the
 * app knew whether a failed read meant "the credential is not there" or "the
 * node is down". That distinction is the whole point of this module: a read
 * that never reached the ledger is `unknown`, never `false`.
 *
 * Two halves:
 *   - `classifyRpcError` / `probeRpcHealth` — pure-ish, testable plumbing that
 *     turns anything thrown by the SDK into a typed {@link RpcIssue}.
 *   - a tiny module-level store + `useRpcHealth()` hook, so one banner can
 *     reflect every read in the app and the state updates on its own when the
 *     node comes back. Reads report their own outcome (see
 *     lib/contract-simulation.ts) so an outage is noticed even when nothing
 *     else is polling.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { RPC_URL } from "./stellar";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Why a ledger read could not produce an answer.
 *   rpc-unreachable — the endpoint did not answer (or throttled). The
 *                     network is down / unreachable: the state is *unknown*.
 *   not-configured  — the app has no contract id for this deployment, so the
 *                     read could not have been meaningful either way.
 *   read-failed     — the node answered but the read produced no result.
 */
export type RpcIssueKind = "rpc-unreachable" | "not-configured" | "read-failed";

export interface RpcIssue {
  kind: RpcIssueKind;
  /** Human-readable reason, safe to surface in the UI or a tooltip. */
  message: string;
}

/** App-wide RPC state. `unchecked` means nothing has been probed yet. */
export interface RpcHealthState {
  status: "unchecked" | "ok" | "degraded";
  issue: RpcIssue | null;
  /** Epoch ms of the last probe or reported read outcome; 0 if never. */
  checkedAt: number;
}

const UNCHECKED: RpcHealthState = { status: "unchecked", issue: null, checkedAt: 0 };

// ── Classification ───────────────────────────────────────────────────────────

/** Substrings that mean "the request never got a usable answer from the node". */
const UNREACHABLE_PATTERNS = [
  "failed to fetch",
  "fetch failed",
  "networkerror",
  "network request failed",
  "network error",
  "load failed",
  "econnrefused",
  "econnreset",
  "econnaborted",
  "enotfound",
  "eai_again",
  "etimedout",
  "esockettimedout",
  "socket hang up",
  "socket closed",
  "timed out",
  "timeout",
  "timeout of",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "internal server error",
  "too many requests",
  "rate limit",
  " 429",
  " 500",
  " 502",
  " 503",
  " 504",
];

/** Substrings that mean the app itself is not pointed at a real deployment. */
const NOT_CONFIGURED_PATTERNS = [
  "not configured",
  "missing contract",
  "no contract",
  "next_public_proof_registry_id",
  "contract not found",
  "contract not existent",
];

/**
 * Turn anything thrown by the SDK (or a simulation error's message) into a
 * typed {@link RpcIssue}. Never throws, never guesses a boolean — the caller
 * decides what "unknown" means for its surface.
 */
export function classifyRpcError(error: unknown): RpcIssue {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error == null
          ? ""
          : JSON.stringify(error);
  const message = raw.toLowerCase();

  const configured = NOT_CONFIGURED_PATTERNS.some((p) => message.includes(p));
  if (configured) {
    return {
      kind: "not-configured",
      message: "This build has no ProofRegistry configured, so no claim status can be read.",
    };
  }

  const unreachable = UNREACHABLE_PATTERNS.some((p) => message.includes(p));
  if (unreachable) {
    return {
      kind: "rpc-unreachable",
      message: `The Stellar RPC endpoint at ${hostOf(RPC_URL)} is not responding.`,
    };
  }

  return {
    kind: "read-failed",
    message: raw ? `The claim could not be read: ${truncate(raw, 140)}` : "The claim could not be read.",
  };
}

/** True when the read failed because the node itself is unusable. */
export function isRpcOutage(issue: RpcIssue | null | undefined): boolean {
  return issue?.kind === "rpc-unreachable";
}

/**
 * A missing holder account is a *definitive* negative, not an outage: an
 * address that does not exist on the ledger cannot hold proofs, and the node
 * answered to say so. Everything else that "not found" can mean (a contract
 * that is not deployed on this network) stays unknown.
 */
export function isMissingAccountError(error: unknown): boolean {
  const raw =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === "string"
        ? error
        : "";
  const message = raw.toLowerCase();
  // Transport failures win: an outage whose message happens to mention an
  // account is an outage, not proof that the holder has no proofs.
  if (UNREACHABLE_PATTERNS.some((p) => message.includes(p))) return false;
  return (
    message.includes("accountnotfound") ||
    message.includes("account not found") ||
    message.includes("no account was found")
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── Store ────────────────────────────────────────────────────────────────────

let state: RpcHealthState = UNCHECKED;
const listeners = new Set<() => void>();

function setState(next: RpcHealthState) {
  // Keep identity stable when nothing changed so useSyncExternalStore does
  // not re-render on every no-op probe.
  if (
    state.status === next.status &&
    state.checkedAt === next.checkedAt &&
    state.issue?.message === next.issue?.message
  ) {
    return;
  }
  state = next;
  for (const l of listeners) l();
}

export function getRpcHealth(): RpcHealthState {
  return state;
}

export function subscribeRpcHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Report a successful ledger read (or probe): the node answered. */
export function reportRpcHealthy(): void {
  setState({ status: "ok", issue: null, checkedAt: Date.now() });
}

/** Report a read that produced no answer, plus why. */
export function reportRpcIssue(issue: RpcIssue): void {
  setState({ status: "degraded", issue, checkedAt: Date.now() });
}

/** Reset the shared state. Test-only. */
export function resetRpcHealth(): void {
  listeners.clear();
  state = UNCHECKED;
}

// ── Probe ────────────────────────────────────────────────────────────────────

export const RPC_PROBE_TIMEOUT_MS = 8_000;
export const RPC_HEALTH_POLL_MS = 20_000;

class RpcProbeTimeout extends Error {
  constructor(ms: number) {
    super(`RPC health probe timed out after ${ms}ms`);
    this.name = "RpcProbeTimeout";
  }
}

type SDK = typeof import("@stellar/stellar-sdk");

let sdkPromise: Promise<SDK> | null = null;
function sdk(): Promise<SDK> {
  if (!sdkPromise) sdkPromise = import("@stellar/stellar-sdk");
  return sdkPromise;
}

let probeServer: InstanceType<SDK["rpc"]["Server"]> | null = null;
async function getProbeServer() {
  if (!probeServer) {
    const { rpc } = await sdk();
    probeServer = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
  }
  return probeServer;
}

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RpcProbeTimeout(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ask the node for its latest ledger. Resolves with `null` when the network is
 * usable, or the {@link RpcIssue} that explains why it is not. Updates the
 * shared store either way, so this doubles as the app's reachability probe.
 */
export async function probeRpcHealth(
  opts: { timeoutMs?: number } = {},
): Promise<RpcIssue | null> {
  try {
    const server = await getProbeServer();
    await withDeadline(server.getLatestLedger(), opts.timeoutMs ?? RPC_PROBE_TIMEOUT_MS);
    reportRpcHealthy();
    return null;
  } catch (e) {
    const issue =
      e instanceof RpcProbeTimeout
        ? { kind: "rpc-unreachable" as const, message: `The Stellar RPC endpoint at ${hostOf(RPC_URL)} did not respond in time.` }
        : classifyRpcError(e);
    reportRpcIssue(issue);
    return issue;
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Subscribe to the app-wide RPC state. Probes on mount, then every `pollMs`
 * while mounted, and re-probes as soon as the browser reports it is back
 * online. `recheck` forces an immediate probe (used by retry buttons).
 */
export function useRpcHealth(pollMs: number = RPC_HEALTH_POLL_MS) {
  const health = useSyncExternalStore(subscribeRpcHealth, getRpcHealth, getRpcHealth);

  const recheck = useCallback(() => {
    void probeRpcHealth();
  }, []);

  useEffect(() => {
    void probeRpcHealth();
    const timer = setInterval(() => {
      void probeRpcHealth();
    }, pollMs);
    const onOnline = () => {
      void probeRpcHealth();
    };
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [pollMs]);

  return {
    ...health,
    degraded: health.status === "degraded",
    recheck,
  };
}
