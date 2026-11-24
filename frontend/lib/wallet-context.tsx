"use client";

// Global wallet connection state. Lives in the root layout so it survives client
// navigation between pages (the layout never unmounts), and restores from
// localStorage on a full page reload — so you connect once, not per page.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  connect as kitConnect,
  restore as kitRestore,
  hasLiveWalletSession,
  getLedger,
  getNetworkOk,
  WalletConnectError,
} from "./wallet";

const STORAGE_KEY = "stellarcred:wallet-id";
const NETWORK_POLL_MS = 4_000;
export const WALLET_SESSION_HEARTBEAT_MS = 5_000;
export const WALLET_SESSION_GRACE_PERIOD_MS = 60_000;

interface WalletState {
  address: string;
  /** True while a previously saved connection is being restored on mount. */
  restoring: boolean;
  /** Kit id of the connected wallet ("ledger" for a hardware wallet). */
  walletId: string;
  connecting: boolean;
  error: WalletConnectError | null;
  networkMismatch: boolean;
  /** Timestamp of the first failed heartbeat in the current disconnect window. */
  sessionLostAt: number | null;
  /**
   * True when a Ledger's USB session dropped after connecting (cable pulled,
   * device re-locked). The device has to be reconnected and reopened on the
   * Stellar app; nothing was signed in the meantime (issue #1040).
   */
  ledgerDisconnected: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState("");
  const [restoring, setRestoring] = useState(true);
  const [walletId, setWalletId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<WalletConnectError | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState(false);
  const [ledgerDisconnected, setLedgerDisconnected] = useState(false);
  const [sessionLostAt, setSessionLostAt] = useState<number | null>(null);
  const [heartbeatEpoch, setHeartbeatEpoch] = useState(0);

  // Restore a prior connection on mount (full reload).
  useEffect(() => {
    let cancelled = false;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      // storage unavailable (private mode / blocked) — skip restore
      setRestoring(false);
      return;
    }
    if (!saved) {
      setRestoring(false);
      return;
    }
    kitRestore(saved)
      .then((restored) => {
        if (!cancelled) setAddress(restored);
      .then((restoredAddress) => {
        setAddress(restoredAddress);
        setWalletId(saved);
      })
      .catch(() => {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // storage unavailable — nothing to remove
        }
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A Ledger can vanish mid-session (cable, hub, device sleep). The transport
  // reports it so the UI can say what happened instead of failing silently on
  // the next signature; retrying reopens the USB session.
  useEffect(() => {
    if (walletId !== "ledger" || !address) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    getLedger()
      .then((ledger) => {
        if (cancelled) return;
        unsubscribe = ledger.onDisconnect(() => {
          if (!cancelled) {
            setLedgerDisconnected(true);
            setSessionLostAt((lostAt) => lostAt ?? Date.now());
          }
        });
      })
      .catch(() => {
        // the module failed to load; connection errors surface on next use
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [walletId, address]);

  // Poll the wallet's live network while connected, so a network switch made
  // after connecting is caught without requiring a reconnect.
  useEffect(() => {
    if (!address) return;
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

  // Some wallets do not emit a reliable disconnect event. Polling getAddress()
  // is a lightweight active heartbeat; keep the last known address during the
  // grace period so route-level forms remain mounted while the holder reconnects.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    let checking = false;
    const checkSession = async () => {
      if (checking) return;
      checking = true;
      try {
        const live = await hasLiveWalletSession(address, walletId);
        if (cancelled) return;
        if (live) setSessionLostAt(null);
        else setSessionLostAt((lostAt) => lostAt ?? Date.now());
      } finally {
        checking = false;
      }
    };
    void checkSession();
    const id = setInterval(() => void checkSession(), WALLET_SESSION_HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [address, walletId, heartbeatEpoch]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const { address, walletId } = await kitConnect();
      setAddress(address);
      setWalletId(walletId);
      setLedgerDisconnected(false);
      setSessionLostAt(null);
      setHeartbeatEpoch((epoch) => epoch + 1);
      localStorage.setItem(STORAGE_KEY, walletId);
    } catch (e) {
      const err =
        e instanceof WalletConnectError
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
    setWalletId("");
    setError(null);
    setNetworkMismatch(false);
    setLedgerDisconnected(false);
    setSessionLostAt(null);
    setHeartbeatEpoch((epoch) => epoch + 1);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable — nothing to remove
    }
  }, []);

  return (
    <WalletContext.Provider
      value={{ address, restoring, connecting, error, networkMismatch, connect, disconnect }}
      value={{
        address,
        walletId,
        connecting,
        error,
        networkMismatch,
        sessionLostAt,
        ledgerDisconnected,
        connect,
        disconnect,
      }}
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
