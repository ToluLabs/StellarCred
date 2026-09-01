"use client";

// Global wallet connection state. Lives in the root layout so it survives client
// navigation between pages (the layout never unmounts), and restores from
// localStorage on a full page reload — so you connect once, not per page.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  connect as kitConnect,
  restore as kitRestore,
  getNetworkOk,
  WalletConnectError,
} from "./wallet";

const STORAGE_KEY = "stellarcred:wallet-id";
const NETWORK_POLL_MS = 4_000;

interface WalletState {
  address: string;
  connecting: boolean;
  error: WalletConnectError | null;
  networkMismatch: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<WalletConnectError | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState(false);

  // Restore a prior connection on mount (full reload).
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // storage unavailable (private mode / blocked) — skip restore
      return;
    }
    if (!saved) return;
    kitRestore(saved)
      .then(setAddress)
      .catch(() => {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // storage unavailable — nothing to remove
        }
      });
  }, []);

  // Poll the wallet's live network while connected, so a network switch made
  // after connecting is caught without requiring a reconnect.
  useEffect(() => {
    if (!address) {
      setNetworkMismatch(false);
      return;
    }
    let cancelled = false;
    const check = () => {
      getNetworkOk().then((ok) => {
        if (!cancelled) setNetworkMismatch(!ok);
      });
    };
    check();
    const id = setInterval(check, NETWORK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [address]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const { address, walletId } = await kitConnect();
      setAddress(address);
      localStorage.setItem(STORAGE_KEY, walletId);
    } catch (e) {
      const err = e instanceof WalletConnectError
        ? e
        : new WalletConnectError("unknown", (e as Error).message ?? "Something went wrong");
      // Surface every kind — including "dismissed". Cancellations are rendered
      // as a benign note (not a hard error) via WalletErrorInfo.benign, per
      // the per-kind error mapping requirement.
      setError(err);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress("");
    setError(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable — nothing to remove
    }
  }, []);

  return (
    <WalletContext.Provider
      value={{ address, connecting, error, networkMismatch, connect, disconnect }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}

export function usePreviewMode(): boolean {
  const { address } = useWallet();
  return !address;
}
