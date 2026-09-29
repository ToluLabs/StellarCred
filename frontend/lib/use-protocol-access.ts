"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { checkClaim } from "@/lib/contracts";
import type { RpcIssue } from "@/lib/rpc-health";
import type { Requirement } from "@/lib/protocols";

/**
 * Per-card (or per-protocol) access-check lifecycle.
 *
 * `unknown` is deliberately distinct from `denied`: a read that never reached
 * the ledger proves nothing about the holder (Issue #634). `error` is kept for
 * a throw that is not a read result at all.
 */
export type AccessCheckState =
  | "idle"
  | "loading"
  | "granted"
  | "denied"
  | "unknown"
  | "error";

const DEBOUNCE_MS = 300;

/**
 * Runs on-chain `check_claim` for each requirement with:
 * - immediate `loading` on wallet/network change (no flicker of stale granted/denied)
 * - debounced RPC so rapid wallet/network flips don't hammer the node
 * - `unknown` (not `denied`) for reads that produced no answer, with the
 *   {@link RpcIssue} attached so the UI can attribute it to the network
 */
export function useProtocolAccessCheck(
  requirements: Requirement[],
  activeWallet: string | null,
  opts: { isPreview?: boolean; networkKey?: string | boolean } = {},
) {
  const { isPreview = false, networkKey } = opts;

  const [state, setState] = useState<AccessCheckState>("idle");
  const [statuses, setStatuses] = useState<(boolean | null)[]>(() =>
    requirements.map(() => false),
  );
  const [issue, setIssue] = useState<RpcIssue | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // Stable fingerprint so parent re-renders with the same requirements don't re-fire.
  const reqKey = requirements.map((r) => `${r.type}:${r.minThreshold ?? ""}`).join("|");
  const reqRef = useRef(requirements);
  reqRef.current = requirements;

  const retry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const reqs = reqRef.current;

    if (isPreview) {
      setStatuses(reqs.map(() => true));
      setIssue(null);
      setState("granted");
      return;
    }

    if (!activeWallet) {
      setStatuses(reqs.map(() => false));
      setIssue(null);
      setState("idle");
      return;
    }

    // Drop any previous granted/denied immediately so the UI never flashes.
    setState("loading");

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const results = await Promise.all(
            reqs.map((r) => checkClaim(activeWallet, r.type, r.minThreshold)),
          );
          if (cancelled) return;
          // A single unreadable requirement makes the whole decision unreadable:
          // "cannot determine" must never be collapsed into "denied".
          const unknown = results.find((r) => r.status === "unknown");
          if (unknown && unknown.status === "unknown") {
            setStatuses(results.map((r) => (r.status === "unknown" ? null : r.proved)));
            setIssue(unknown.issue);
            setState("unknown");
            return;
          }
          setIssue(null);
          const proved = results.map((r) => (r.status === "unknown" ? null : r.proved));
          setStatuses(proved);
          setState(proved.every(Boolean) ? "granted" : "denied");
        } catch {
          if (cancelled) return;
          // Keep prior requirement booleans but surface error — never treat RPC
          // failure as a definitive "denied".
          setState("error");
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeWallet, isPreview, networkKey, reqKey, retryNonce]);

  return {
    state,
    statuses,
    /** Why the read could not be answered, when `state === "unknown"`. */
    issue,
    retry,
    eligible: state === "granted",
    checking: state === "loading",
    /** True when the access decision could not be made from the ledger. */
    unresolved: state === "unknown" || state === "error",
  };
}
