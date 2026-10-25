"use client";

/**
 * useCredentialStore — single source of truth for credential state.
 *
 * Combines:
 *   - initial load from localStorage with request sequence tracking
 *   - cross-tab sync via StorageEvent
 *   - functional state updaters to eliminate stale credential data
 *   - request invalidation preventing delayed network responses from overwriting cache updates
 *   - imperative CRUD (save, remove, removeMultiple, markCredentialProved, markCredentialsProved)
 *
 * Every effect has a minimal, stable dependency set (no exhaustive-deps hacks).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Credential,
  loadCredentials,
  saveCredential,
  removeCredential,
  removeCredentials,
  markProved as _markProved,
  markAllProved as _markAllProved,
  createSaveCredentialUpdater,
  createRemoveCredentialUpdater,
  createRemoveAllCredentialsUpdater,
  createMarkProvedUpdater,
  createMarkAllProvedUpdater,
} from "../credential";
import { isStorageAvailable } from "../safe-storage";

const STORAGE_KEY = "stellarcred:credentials";

export function useCredentialStore() {
  const [creds, setCreds] = useState<Credential[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // ── Initial load ──────────────────────────────────────────────────────────
  // The credential store is async, so hydrate on mount with request sequencing.
  useEffect(() => {
    const reqId = ++requestIdRef.current;
    loadCredentials().then((loaded) => {
      if (isMountedRef.current && reqId === requestIdRef.current) {
        setCreds(loaded);
        setIsLoaded(true);
      }
    });
  }, []);

  // ── Cross-tab sync ────────────────────────────────────────────────────────
  // When another tab writes to the credentials localStorage key, reload.
  // Debounced (100 ms) to avoid thrash on rapid batch writes.
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isStorageAvailable()) return;

    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
          const reqId = ++requestIdRef.current;
          loadCredentials().then((loaded) => {
            if (isMountedRef.current && reqId === requestIdRef.current) {
              setCreds(loaded);
            }
          });
        }, 100);
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []); // mount-only: STORAGE_KEY is a module constant

  // ── CRUD ───────────────────────────────────────────────────────────────────

  const reload = useCallback(() => {
    const reqId = ++requestIdRef.current;
    return loadCredentials().then((loaded) => {
      if (isMountedRef.current && reqId === requestIdRef.current) {
        setCreds(loaded);
        setIsLoaded(true);
      }
      return loaded;
    });
  }, []);

  const save = useCallback((cred: Credential) => {
    // Update state immediately with functional update to avoid stale data lag
    setCreds(createSaveCredentialUpdater(cred));
    // Invalidate any in-flight reloads from overwriting this fresh update
    requestIdRef.current++;
    // Persist to storage in background
    return saveCredential(cred);
  }, []);

  const remove = useCallback((commitment: string) => {
    // Update state immediately with functional update to avoid stale data lag
    setCreds(createRemoveCredentialUpdater(commitment));
    // Invalidate any in-flight reloads from overwriting this fresh update
    requestIdRef.current++;
    // Persist to storage in background
    return removeCredential(commitment);
  }, []);

  const removeMultiple = useCallback((commitments: string[]) => {
    // Update state immediately with functional update to avoid stale data lag
    setCreds(createRemoveAllCredentialsUpdater(commitments));
    // Invalidate any in-flight reloads from overwriting this fresh update
    requestIdRef.current++;
    // Persist to storage in background in a single write
    return removeCredentials(commitments);
  }, []);

  const markCredentialProved = useCallback((commitment: string, txHash: string) => {
    // Update state immediately with functional update to avoid stale data lag
    setCreds(createMarkProvedUpdater(commitment, txHash));
    // Invalidate any in-flight reloads from overwriting this fresh update
    requestIdRef.current++;
    // Persist to storage in background
    return _markProved(commitment, txHash);
  }, []);

  const markCredentialsProved = useCallback((commitments: string[], txHash: string) => {
    // Update state immediately with functional update to avoid stale data lag
    setCreds(createMarkAllProvedUpdater(commitments, txHash));
    // Invalidate any in-flight reloads from overwriting this fresh update
    requestIdRef.current++;
    // Persist to storage in background
    return _markAllProved(commitments, txHash);
  }, []);

  return {
    creds,
    isLoaded,
    reload,
    save,
    remove,
    removeMultiple,
    markCredentialProved,
    markCredentialsProved,
  };
}
