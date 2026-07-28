"use client";

// Thin wrapper around Stellar Wallets Kit (Freighter, xBull, etc.).
// The kit's `network` option configures which network the kit signs for; it does
// NOT switch the wallet extension's own selected network. Network mismatches are
// therefore not treated as connect-time failures here — wallet-context.tsx polls
// getNetworkOk() live after connecting so the UI can show a persistent warning
// that clears itself the moment the user switches networks, without reconnecting.

import {
  StellarWalletsKit,
  WalletNetwork,
  allowAllModules,
  FREIGHTER_ID,
} from "@creit.tech/stellar-wallets-kit";
import { NETWORK, NETWORK_PASSPHRASE } from "./stellar";

const APP_NETWORK =
  NETWORK === "public" ? WalletNetwork.PUBLIC : WalletNetwork.TESTNET;

const CONNECT_TIMEOUT_MS = 30_000;
const FREIGHTER_URL = "https://freighter.app";

let kit: StellarWalletsKit | null = null;

export function getKit(): StellarWalletsKit {
  if (!kit) {
    kit = new StellarWalletsKit({
      network: APP_NETWORK,
      selectedWalletId: FREIGHTER_ID,
      modules: allowAllModules(),
    });
  }
  return kit;
}

export type WalletErrorKind = "not-installed" | "dismissed" | "rejected" | "timeout" | "unknown";

export class WalletConnectError extends Error {
  kind: WalletErrorKind;
  constructor(kind: WalletErrorKind, message: string) {
    super(message);
    this.name = "WalletConnectError";
    this.kind = kind;
  }
}

export const FREIGHTER_INSTALL_URL = FREIGHTER_URL;

// Map whatever the kit/wallet extension throws into one of our known error
// kinds. There's no stable, documented string for "user declined in the
// extension popup" (it's internal to each wallet extension, not the npm
// package), so any post-selection failure that isn't the well-known
// "not installed" message is treated as a cancellation.
function toWalletError(e: unknown): WalletConnectError {
  if (e instanceof WalletConnectError) return e;
  const message =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
  if (/not connected|not available/i.test(message)) {
    return new WalletConnectError(
      "not-installed",
      "No Stellar wallet extension found. Install Freighter to continue.",
    );
  }
  return new WalletConnectError("rejected", "Connection cancelled");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new WalletConnectError(
          "timeout",
          "Connection timed out. Check your wallet extension and try again.",
        ),
      );
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Live network check — reads from the connected wallet, not hardcoded. Returns
// true if the wallet doesn't support getNetwork() at all, to avoid a
// false-positive mismatch warning.
export async function getNetworkOk(): Promise<boolean> {
  try {
    const { networkPassphrase } = await getKit().getNetwork();
    return !networkPassphrase || networkPassphrase === NETWORK_PASSPHRASE;
  } catch {
    return true;
  }
}

export interface Connection {
  address: string;
  walletId: string;
}

export async function connect(): Promise<Connection> {
  const k = getKit();
  const attempt = new Promise<Connection>((resolve, reject) => {
    k.openModal({
      onWalletSelected: async (option) => {
        try {
          k.setWallet(option.id);
          const { address } = await k.getAddress();
          resolve({ address, walletId: option.id });
        } catch (e) {
          reject(toWalletError(e));
        }
      },
      onClosed: () => reject(new WalletConnectError("dismissed", "Connection cancelled")),
    });
  });
  return withTimeout(attempt, CONNECT_TIMEOUT_MS);
}

// Restore a previously-selected wallet (no modal) after a full page reload.
export async function restore(walletId: string): Promise<string> {
  const k = getKit();
  k.setWallet(walletId);
  const { address } = await k.getAddress();
  return address;
}

/** Sign a transaction XDR with the connected wallet; returns the signed XDR. */
export async function signTx(xdr: string, address: string): Promise<string> {
  const k = getKit();
  const { signedTxXdr } = await k.signTransaction(xdr, {
    address,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  return signedTxXdr;
}
