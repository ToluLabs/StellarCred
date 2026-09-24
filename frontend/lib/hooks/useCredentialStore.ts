"use client";

/**
 * useCredentialStore — single source of truth for credential state.
 *
 * Combines:
 *   - initial load from localStorage
 *   - cross-tab sync via StorageEvent
 *   - imperative CRUD (save, remove, markProved, markAllProved)
 *
 * Every effect has a minimal, stable dependency set (no exhaustive-deps hacks).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Credential,
  loadCredentials,
  saveCredential,
  removeCredential,
  markProved as _markProved,
  markAllProved as _markAllProved,
} from "../credential";
import { isStorageAvailable } from "../safe-storage";

const STORAGE_KEY = "stellarcred:credentials";

export function useCredentialStore() {
  const [creds, setCreds] = useState<Credential[]>([]);

  // ── Initial load ──────────────────────────────────────────────────────────
  // The credential store is async, so hydrate on mount.
  useEffect(() => {
    loadCredentials().then(setCreds);
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
          loadCredentials().then(setCreds);
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
    loadCredentials().then(setCreds);
  }, []);

  const save = useCallback((cred: Credential) => {
    saveCredential(cred).then(setCreds);
  }, []);

  const remove = useCallback((commitment: string) => {
    removeCredential(commitment).then(setCreds);
  }, []);

  const markCredentialProved = useCallback((commitment: string, txHash: string) => {
    _markProved(commitment, txHash).then(setCreds);
  }, []);

  const markCredentialsProved = useCallback((commitments: string[], txHash: string) => {
    _markAllProved(commitments, txHash).then(setCreds);
  }, []);

  return {
    creds,
    reload,
    save,
    remove,
    markCredentialProved,
    markCredentialsProved,
  };
}
