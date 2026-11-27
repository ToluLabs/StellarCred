"use client";

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
const CROSS_TAB_DEBOUNCE_MS = 100;

export function useCredentialStore() {
  const [creds, setCreds] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate once. A later reload, mutation, or storage event invalidates this
  // request so an older response cannot replace newer credential state.
  useEffect(() => {
    let cancelled = false;
    const requestId = ++requestIdRef.current;

    loadCredentials()
      .then((loaded) => {
        if (!cancelled && requestId === requestIdRef.current) {
          setCreds(loaded);
        }
      })
      .catch(() => {
        if (!cancelled && requestId === requestIdRef.current) {
          setCreds([]);
        }
      })
      .finally(() => {
        if (!cancelled && requestId === requestIdRef.current) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // A storage event is raised in other tabs, not in the tab that made the
  // write. Invalidate in-flight reads immediately, before starting the debounce.
  useEffect(() => {
    if (!isStorageAvailable()) return;

    let cancelled = false;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;

      const requestId = ++requestIdRef.current;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);

      timeoutRef.current = setTimeout(() => {
        loadCredentials()
          .then((loaded) => {
            if (!cancelled && requestId === requestIdRef.current) {
              setCreds(loaded);
              setLoading(false);
            }
          })
          .catch(() => {
            if (!cancelled && requestId === requestIdRef.current) {
              setCreds([]);
              setLoading(false);
            }
          });
      }, CROSS_TAB_DEBOUNCE_MS);
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", handleStorage);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const reload = useCallback(() => {
    const requestId = ++requestIdRef.current;
    return loadCredentials().then((loaded) => {
      if (requestId === requestIdRef.current) {
        setCreds(loaded);
        setLoading(false);
      }
      return loaded;
    });
  }, []);

  // Each mutation invalidates every read started before it. Only the latest
  // operation is allowed to publish its result to React state.
  const runMutation = useCallback((operation: () => Promise<Credential[]>) => {
    const requestId = ++requestIdRef.current;
    return operation().then((updated) => {
      if (requestId === requestIdRef.current) {
        setCreds(updated);
        setLoading(false);
      }
      return updated;
    });
  }, []);

  const save = useCallback(
    (credential: Credential) => runMutation(() => saveCredential(credential)),
    [runMutation],
  );

  const remove = useCallback(
    (commitment: string) => runMutation(() => removeCredential(commitment)),
    [runMutation],
  );

  const markCredentialProved = useCallback(
    (commitment: string, txHash: string) => runMutation(() => _markProved(commitment, txHash)),
    [runMutation],
  );

  const markCredentialsProved = useCallback(
    (commitments: string[], txHash: string) =>
      runMutation(() => _markAllProved(commitments, txHash)),
    [runMutation],
  );

  return {
    creds,
    loading,
    reload,
    save,
    remove,
    markCredentialProved,
    markCredentialsProved,
  };
}
