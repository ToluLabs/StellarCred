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
import { connect as kitConnect, restore as kitRestore } from "./wallet";

const STORAGE_KEY = "stellarcred:wallet-id";

interface WalletState {
  address: string;
  connecting: boolean;
  error: string;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  // Restore a prior connection on mount (full reload).
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    kitRestore(saved)
      .then(setAddress)
      .catch(() => localStorage.removeItem(STORAGE_KEY));
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError("");
    try {
      const { address, walletId } = await kitConnect();
      setAddress(address);
      localStorage.setItem(STORAGE_KEY, walletId);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== "dismissed") setError(msg);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress("");
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return (
    <WalletContext.Provider
      value={{ address, connecting, error, connect, disconnect }}
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
