// Deterministic cache invalidation for wallet session and credential updates (#942).

import { clearAllProofCache } from "./proof-cache";
import { lockCredentialStore } from "./credential";
import { destroyAllBackends } from "./proof";

export interface CacheInvalidationOptions {
  address?: string;
  reason?: "disconnect" | "account-change" | "network-change" | "credential-update" | "refresh";
  clearLocalStorage?: boolean;
}

const CACHE_KEYS_TO_CLEAR = [
  "stellarcred:wallet-session",
  "stellarcred:credential-cache",
  "stellarcred:trust-cache",
  "stellarcred:network-cache",
];

export const CACHE_INVALIDATION_EVENT = "stellarcred:cache-invalidated";

type InvalidationCallback = (options: CacheInvalidationOptions) => void;
const listeners = new Set<InvalidationCallback>();

/**
 * Register an in-memory cache callback that triggers whenever cache is invalidated.
 * Returns an unregister function.
 */
export function registerCacheInvalidationListener(callback: InvalidationCallback): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Deterministically invalidates cached wallet, credential, and proof data.
 * Safe to call in browser and SSR environments.
 */
export function invalidateWalletSessionCache(options: CacheInvalidationOptions = {}): void {
  const { reason = "refresh", clearLocalStorage = false } = options;

  // 1. Invalidate cryptographic proof cache
  try {
    clearAllProofCache();
  } catch {
    // proof cache unavailable or storage blocked
  }

  // 2. Tear down any active prover backend wasm memory
  try {
    void destroyAllBackends();
  } catch {
    // prover cleanup failed
  }

  // 3. Lock credential store and erase derived keys from memory
  try {
    lockCredentialStore();
  } catch {
    // credential store unavailable
  }

  // 4. Trigger in-memory cache listeners
  for (const listener of listeners) {
    try {
      listener(options);
    } catch {
      // listener failure suppressed
    }
  }

  // 5. Clear transient storage keys if window is present
  if (typeof window !== "undefined") {
    try {
      for (const key of CACHE_KEYS_TO_CLEAR) {
        sessionStorage.removeItem(key);
        if (clearLocalStorage) {
          localStorage.removeItem(key);
        }
      }
    } catch {
      // storage unavailable
    }

    // 6. Notify listening components to trigger fresh reads
    try {
      window.dispatchEvent(
        new CustomEvent(CACHE_INVALIDATION_EVENT, {
          detail: {
            reason,
            address: options.address ?? null,
            timestamp: Date.now(),
          },
        }),
      );
    } catch {
      // custom event dispatch failed
    }
  }
}

/**
 * Invalidate credential-specific cache when issuance or revocation occurs.
 */
export function invalidateCredentialCache(
  _reason: "issuance" | "revocation" | "update" = "update",
): void {
  invalidateWalletSessionCache({ reason: "credential-update" });
}
