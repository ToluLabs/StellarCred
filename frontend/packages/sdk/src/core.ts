// @stellarcred/sdk — framework-agnostic core
//
// `createClaimGate` is the framework-agnostic entry point for gating UI on
// verified claims. It exposes subscribe/unsubscribe so any framework
// (React, Vue, Svelte, vanilla JS) can react to claim state changes.
// No React import.
//
//   import { createClaimGate } from "@stellarcred/sdk";
//
//   const gate = createClaimGate({ wallet: "G…" });
//   gate.subscribe((state) => console.log(state));
//   // later: gate.destroy();

import { hasClaims, type ClaimType } from "./claims";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClaimGateConfig {
  /** Wallet address to check claims for. Null means no wallet connected. */
  wallet: string | null;

  /** Which claim types to check. Defaults to all supported claim types. */
  claims?: ClaimType[];

  /** Minimum thresholds for parameterised claims (age, income, funds). */
  minThresholds?: Partial<Record<ClaimType, number>>;

  /**
   * Restrict claims to proofs from specific trusted issuers.
   */
  trustedIssuers?: string[];
}

export interface ClaimGateState {
  /** Map of claim type → verified status. null means not yet fetched. */
  claims: Partial<Record<ClaimType, boolean>> | null;

  /** True while a claim-check is in flight. */
  loading: boolean;

  /** Set on errors; cleared on refetch. */
  error: Error | null;
}

export type ClaimGateListener = (state: ClaimGateState) => void;

export interface ClaimGate {
  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: ClaimGateListener): () => void;

  /** Remove a previously-registered listener. */
  unsubscribe(listener: ClaimGateListener): void;

  /** Return the current state synchronously. */
  getSnapshot(): ClaimGateState;

  /** Re-run all claim checks. */
  refetch(): void;

  /** Stop all pending work and clear listeners. Call on teardown. */
  destroy(): void;
}

// ── Default claims ───────────────────────────────────────────────────────────

const DEFAULT_CLAIMS: ClaimType[] = [
  "kyc",
  "age",
  "jurisdiction",
  "income",
  "funds",
];

// ── Implementation ───────────────────────────────────────────────────────────

export function createClaimGate(config: ClaimGateConfig): ClaimGate {
  const { wallet } = config;

  const claimsToCheck = config.claims ?? DEFAULT_CLAIMS;
  const thresholds = config.minThresholds ?? {};
  const trustedIssuers = config.trustedIssuers;

  const listeners = new Set<ClaimGateListener>();

  let state: ClaimGateState = {
    claims: null,
    loading: true,
    error: null,
  };

  let destroyed = false;

  /**
   * Every fetch gets a unique id.
   *
   * If refetch() is called while an earlier request is still running,
   * the older request is ignored when it finishes. This prevents stale
   * results from overwriting newer results.
   */
  let fetchId = 0;

  function emit() {
    /**
     * Always emit a copy of the claims object so consumers cannot mutate
     * the internal state directly.
     */
    const snapshot: ClaimGateState = {
      claims: state.claims ? { ...state.claims } : null,
      loading: state.loading,
      error: state.error,
    };

    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch {
        // A broken listener must not prevent other listeners from running.
      }
    });
  }

  function setState(partial: Partial<ClaimGateState>) {
    state = {
      ...state,
      ...partial,
    };

    emit();
  }

  async function fetchClaims(): Promise<void> {
    const currentFetchId = ++fetchId;

    // No wallet means there is nothing to check.
    if (!wallet) {
      setState({
        claims: null,
        loading: false,
        error: null,
      });
      return;
    }

    setState({
      loading: true,
      error: null,
    });

    try {
      /**
       * Use the batched hasClaims API.
       *
       * This performs the claim checks through one shared client instead of
       * creating a separate claim-read flow for every claim type.
       */
      const results = await hasClaims(wallet, claimsToCheck, {
        minThresholds: thresholds,
        trustedIssuers,
      });

      /**
       * Do not apply results if:
       * - the gate was destroyed, or
       * - another refetch started after this request.
       */
      if (destroyed || currentFetchId !== fetchId) {
        return;
      }

      setState({
        claims: results,
        loading: false,
        error: null,
      });
    } catch (error) {
      /**
       * Ignore errors from stale requests.
       */
      if (destroyed || currentFetchId !== fetchId) {
        return;
      }

      setState({
        claims: null,
        loading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  // Initial fetch.
  void fetchClaims();

  return {
    subscribe(listener) {
      if (destroyed) {
        return () => {};
      }

      listeners.add(listener);

      // Immediately provide the current state to the new subscriber.
      try {
        listener({
          claims: state.claims ? { ...state.claims } : null,
          loading: state.loading,
          error: state.error,
        });
      } catch {
        // Ignore listener errors.
      }

      return () => {
        listeners.delete(listener);
      };
    },

    unsubscribe(listener) {
      listeners.delete(listener);
    },

    getSnapshot() {
      return {
        claims: state.claims ? { ...state.claims } : null,
        loading: state.loading,
        error: state.error,
      };
    },

    refetch() {
      if (destroyed) {
        return;
      }

      void fetchClaims();
    },

    destroy() {
      destroyed = true;

      /**
       * Incrementing fetchId invalidates any in-flight request.
       */
      fetchId++;

      listeners.clear();
    },
  };
}