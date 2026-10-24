"use client";

// Thin wrapper around Stellar Wallets Kit (Freighter, Albedo, xBull, Rabet,
// Lobstr, Hana, HotWallet, Klever, WalletConnect, ...).
// The kit's `network` option configures which network the kit signs for; it does
// NOT switch the wallet extension's own selected network. Network mismatches are
// therefore not treated as connect-time failures here — wallet-context.tsx polls
// getNetworkOk() live after connecting so the UI can show a persistent warning
// that clears itself the moment the user switches networks, without reconnecting.
//
// The kit is a large dependency (stellar-wallets-kit, WalletConnect + pino, ~200
// KB gzipped in the common chunk) that every page currently pays for, because it
// is statically imported here. It is lazy-loaded on first use (connect/restore /
// sign) so the root layout — and every page — avoids bundling it.

import { NETWORK_PASSPHRASE, NETWORK, NETWORK_PRESETS } from "./stellar";
import type {
  StellarWalletsKit,
  ModuleInterface,
  WalletNetwork,
} from "@creit.tech/stellar-wallets-kit";
import type { LedgerModule } from "./ledger-module";

// One shared network mapping — previously via kitNetworkForPassphrase() in
// ledger-module.ts. Inlined here as literals so this entry module never
// statically imports the kit (or ledger-module): the WalletNetwork enum values
// ARE the passphrases themselves ("Public Global Stellar Network ; …" for
// PUBLIC, "Test SDF Network ; …" for TESTNET), so this stays in sync by
// construction. The kit has no futurenet enum, so anything that isn't mainnet
// signs as testnet.
const APP_NETWORK = (
  NETWORK_PASSPHRASE === "Public Global Stellar Network ; September 2015"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015"
) as WalletNetwork;

const CONNECT_TIMEOUT_MS = 60_000;
const APP_BASE_URL =
  process.env.NEXT_PUBLIC_STELLARCRED_BASE_URL ?? "https://stellarcred.xyz";
// Get a free project ID at https://cloud.reown.com — WalletConnect is omitted
// from the wallet-picker modal entirely when unset (see loadKit() below), it
// isn't a hard error.
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

let kitPromise: Promise<StellarWalletsKit> | null = null;
let ledgerModule: LedgerModule | null = null;

async function loadKit(): Promise<StellarWalletsKit> {
  if (!kitPromise) {
    kitPromise = (async () => {
      const [kitModule, walletConnectModuleModule, ledgerModuleModule] =
        await Promise.all([
          import("@creit.tech/stellar-wallets-kit"),
          import(
            "@creit.tech/stellar-wallets-kit/modules/walletconnect.module"
          ),
          import("./ledger-module"),
        ]);

      const { StellarWalletsKit, allowAllModules, FREIGHTER_ID } = kitModule;

      const { WalletConnectModule, WalletConnectAllowedMethods } =
        walletConnectModuleModule;

      const { getLedgerModule } = ledgerModuleModule;

      const walletConnectModule = (): ModuleInterface | null => {
        if (!WALLETCONNECT_PROJECT_ID) return null;
        return new WalletConnectModule({
          projectId: WALLETCONNECT_PROJECT_ID,
          name: "StellarCred",
          description: "Privacy-preserving on-chain credentials for Stellar",
          url: APP_BASE_URL,
          icons: [`${APP_BASE_URL}/icon.svg`],
          method: WalletConnectAllowedMethods.SIGN,
          network: APP_NETWORK,
        });
      };

      const wc = walletConnectModule();
      ledgerModule = getLedgerModule();
      const modules: ModuleInterface[] = [...allowAllModules()];
      if (wc) modules.push(wc);
      modules.push(ledgerModule);

      return new StellarWalletsKit({
        network: APP_NETWORK,
        selectedWalletId: FREIGHTER_ID,
        modules,
      });
    })();
  }
  return kitPromise;
}

export function getKit(): Promise<StellarWalletsKit> {
  return loadKit();
}

export async function getLedger(): Promise<LedgerModule> {
  await loadKit();
  if (!ledgerModule) {
    // loadKit() always sets this; guard for a mocked/broken kit module.
    const { getLedgerModule } = await import("./ledger-module");
    ledgerModule = getLedgerModule();
  }
  return ledgerModule;
}

export type WalletErrorKind =
  | "not-installed"
  | "dismissed"
  | "rejected"
  | "timeout"
  | "unknown";

export class WalletConnectError extends Error {
  kind: WalletErrorKind;
  /** Display name of the wallet the user was connecting when this failed, if known. */
  walletName?: string;
  /** Where to send the user to install/get the wallet, if known. */
  installUrl?: string;
  constructor(kind: WalletErrorKind, message: string, opts?: { walletName?: string; installUrl?: string }) {
    super(message);
    this.name = "WalletConnectError";
    this.kind = kind;
    this.walletName = opts?.walletName;
    this.installUrl = opts?.installUrl;
  }
}

/**
 * How the UI should present one wallet-connect error. Each `WalletErrorKind`
 * maps to a distinct, actionable message instead of one generic "wallet error"
 * toast, and `benign` flags user-cancellation (dismissed/rejected) so those are
 * shown as a gentle note rather than a scary hard error.
 *
 * `action` tells the renderer which primary affordance to attach:
 *   - "install"    → link the user to the wallet's install url
 *   - "retry"      → a single "Try again" button
 *   - "retry-report" → "Try again" plus a way to report persistent failures
 */
export type WalletErrorAction = "install" | "retry" | "retry-report";

export interface WalletErrorInfo {
  /** Short headline, e.g. "Wallet not installed". */
  title: string;
  /** Full, actionable guidance for this specific error. */
  message: string;
  /** Primary action to attach. */
  action: WalletErrorAction;
  /** True for user-cancellation (dismissed/rejected) — not a hard error. */
  benign: boolean;
}

/**
 * Map a thrown connect error to the human-facing title/message/action the UI
 * renders for its kind. This is the single source of truth for the per-kind
 * copy, kept pure & exported so it can be unit-tested for every kind.
 */
export function getWalletErrorInfo(err: WalletConnectError): WalletErrorInfo {
  switch (err.kind) {
    case "not-installed":
      return {
        title: "Wallet not installed",
        message: err.walletName
          ? `${err.walletName} isn't installed. Install it, or pick another wallet from the list to continue.`
          : "No Stellar wallet extension was found. Install one, or pick another wallet from the list to continue.",
        action: "install",
        benign: false,
      };
    case "dismissed":
      return {
        title: "Connection cancelled",
        message: "You closed the wallet window, so nothing was connected. Just try again when you're ready.",
        action: "retry",
        benign: true,
      };
    case "rejected":
      return {
        title: "Connection declined",
        message: "The wallet declined the connection. If that was a mistake, try again.",
        action: "retry",
        benign: true,
      };
    case "timeout":
      return {
        title: "Wallet didn't respond",
        message: "The wallet didn't respond in time. Check that its popup or extension is open, then try again.",
        action: "retry",
        benign: false,
      };
    case "unknown":
    default:
      return {
        title: "Something went wrong",
        message: "We couldn't connect to your wallet. Please try again — and report it if it keeps happening.",
        action: "retry-report",
        benign: false,
      };
  }
}

/**
 * Pre-filled GitHub issue link used as the "report it" affordance for
 * `unknown` connection failures, so users have a concrete way to surface bugs.
 */
export function getWalletReportUrl(): string {
  const url = new URL("https://github.com/ToluLabs/StellarCred/issues/new");
  url.searchParams.set("labels", "bug");
  url.searchParams.set("title", "Wallet connection failed (unknown error)");
  url.searchParams.set(
    "body",
    "**What were you doing?**\nTrying to connect a Stellar wallet and got a generic failure.\n\n**What did you expect?**\nThe wallet to connect.\n\n**What happened instead?**\nAn unknown error",
  );
  return url.toString();
}

// Map whatever the kit/wallet extension throws into one of our known error
// kinds. There's no stable, documented string for "user declined in the
// extension popup" (it's internal to each wallet extension, not the npm
// package), so any post-selection failure that isn't the well-known
// "not installed" message is treated as a cancellation.
//
// `wallet` carries the id/name/install-url of whichever wallet was being
// connected (from the kit's own ISupportedWallet), so the resulting error —
// and the UI showing it — refers to the wallet the user actually picked
// instead of assuming Freighter.
function toWalletError(e: unknown, wallet?: { id: string; name: string; url: string }): WalletConnectError {
  if (e instanceof WalletConnectError) return e;
  const message =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e);
  // WalletConnect isn't a browser extension — there's nothing to "install".
  // Its own "not connected" errors are relay/session failures (dropped
  // socket, expired session, peer rejection), so it's excluded from the
  // not-installed classification and falls through to "rejected" instead.
  // IDs are inline literals ("wallet_connect" from the kit's
  // walletconnect.module, "ledger" from our LedgerModule) so this pure
  // error-mapping helper never needs a runtime kit/ledger import.
  if (wallet?.id !== "wallet_connect" && wallet?.id !== "ledger" && /not connected|not available/i.test(message)) {
    return new WalletConnectError(
      "not-installed",
      wallet
        ? `${wallet.name} isn't available. Install it to continue.`
        : "No Stellar wallet extension found. Install one to continue.",
      wallet ? { walletName: wallet.name, installUrl: wallet.url } : undefined,
    );
  }
  // Ledger-specific errors: connection issues, device locked, app not open
  if (wallet?.id === "ledger") {
    if (/locked|pin/i.test(message)) {
      return new WalletConnectError(
        "rejected",
        "Ledger is locked. Enter your PIN to continue.",
        { walletName: "Ledger" }
      );
    }
    if (/app.*not.*open|stellar.*app/i.test(message)) {
      return new WalletConnectError(
        "rejected",
        "Open the Stellar app on your Ledger device.",
        { walletName: "Ledger" }
      );
    }
    if (/denied|rejected/i.test(message)) {
      return new WalletConnectError(
        "rejected",
        "Transaction was rejected on the Ledger device.",
        { walletName: "Ledger" }
      );
    }
  }
  // Classify timeout errors from wallet extension / kit / network
  if (/timed?\s*out|timeout/i.test(message)) {
    return new WalletConnectError(
      "timeout",
      "Request timed out while waiting for wallet approval",
      wallet ? { walletName: wallet.name, installUrl: wallet.url } : undefined,
    );
  }
  return new WalletConnectError("rejected", "Connection cancelled");
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = "Request timed out while waiting for wallet approval",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new WalletConnectError(
          "timeout",
          message,
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
    const { networkPassphrase } = await (await getKit()).getNetwork();
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
  const k = await getKit();
  const attempt = new Promise<Connection>((resolve, reject) => {
    let resolved = false;
    k.openModal({
      onWalletSelected: async (option) => {
        try {
          k.setWallet(option.id);
          const { address } = await withTimeout(
            k.getAddress(),
            CONNECT_TIMEOUT_MS,
            "Request timed out while waiting for wallet approval",
          );
          resolved = true;
          resolve({ address, walletId: option.id });
        } catch (e) {
          reject(toWalletError(e, { id: option.id, name: option.name, url: option.url }));
        }
      },
      onClosed: () => {
        if (!resolved) {
          reject(new WalletConnectError("dismissed", "Connection cancelled"));
        }
      },
    });
  });
  return attempt;
}

// Restore a previously-selected wallet (no modal) after a full page reload.
export async function restore(walletId: string): Promise<string> {
  const k = await getKit();
  k.setWallet(walletId);
  const { address } = await k.getAddress();
  return address;
}

/** Sign a transaction XDR with the connected wallet; returns the signed XDR. */
export async function signTx(xdr: string, address: string): Promise<string> {
  const k = await getKit();
  const { signedTxXdr } = await k.signTransaction(xdr, {
    address,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  return signedTxXdr;
}

// ---------------------------------------------------------------------------
// Wallet onboarding helpers (Issue #904)
// ---------------------------------------------------------------------------

/**
 * Known Stellar wallet extensions and their install pages, used by the
 * onboarding UI to surface clear installation guidance when no wallet is
 * detected.
 */
export interface WalletInstallInfo {
  id: string;
  name: string;
  installUrl: string;
  description: string;
  isExtension: boolean;
}

export const KNOWN_WALLETS: WalletInstallInfo[] = [
  {
    id: "freighter",
    name: "Freighter",
    installUrl: "https://www.freighter.app/",
    description: "Self-custody Stellar wallet — browser extension",
    isExtension: true,
  },
  {
    id: "xlxclarolet",
    name: "xBull",
    installUrl: "https://xbull.app/",
    description: "Stellar wallet — browser extension",
    isExtension: true,
  },
  {
    id: "albedo",
    name: "Albedo",
    installUrl: "https://albedo.link/",
    description: "Signing-only web wallet — no installation needed",
    isExtension: false,
  },
  {
    id: "lobstr",
    name: "LOBSTR",
    installUrl: "https://lobstr.co/",
    description: "Stellar wallet — web and mobile",
    isExtension: false,
  },
];

/**
 * Best-effort detection of whether a browser wallet extension is installed.
 * Checks `window.freighterApi` (Freighter) and other known injection points.
 * Returns the wallet id of the first detected extension, or null if none found.
 */
export function detectInstalledWallet(): string | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const freighter = w.freighterApi ?? w.freighter;
  if (freighter) return "freighter";
  return null;
}

/**
 * Returns true when a known Stellar wallet extension appears to be installed.
 */
export function isWalletInstalled(): boolean {
  return detectInstalledWallet() !== null;
}

/**
 * The Stellar network the app is configured for, as a human-readable string.
 */
export function appNetworkName(): string {
  return NETWORK;
}

/**
 * The network name the connected wallet reports, or null if it can't be read.
 */
export async function walletNetworkName(): Promise<string | null> {
  try {
    const { networkPassphrase } = await (await getKit()).getNetwork();
    if (!networkPassphrase) return null;
    for (const [name, preset] of Object.entries(NETWORK_PRESETS)) {
      if (preset.networkPassphrase === networkPassphrase) {
        return name === "mainnet" ? "Mainnet (Public)" : name.charAt(0).toUpperCase() + name.slice(1);
      }
    }
    return "Unknown network";
  } catch {
    return null;
  }
}
