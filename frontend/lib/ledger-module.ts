"use client";

import { NETWORK_PASSPHRASE } from "./stellar";
import { LEDGER_DEFAULT_PATH, isValidLedgerPath } from "./ledger-guide";
import type { ModuleInterface, WalletNetwork } from "@creit.tech/stellar-wallets-kit";
// Runtime type shapes for the Ledger internals. Deliberately type-only: the
// real @ledgerhq/hw-transport entry point isn't a direct dependency of the
// frontend, and TransportWebUSB's instance type carries everything the
// transport field is used for (create()/close()/on()/off()). Keeping these
// typed is what makes the response shapes below (#753) compiler-checked
// instead of runtime-broken behind `any`.
import type TransportWebUSB from "@ledgerhq/hw-transport-webusb";
import type Str from "@ledgerhq/hw-app-str";
import { Buffer } from "buffer";

export const LEDGER_ID = "ledger";
export const LEDGER_NAME = "Ledger";
export const LEDGER_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTMgM2gxOHYxOEgzeiIvPjxwYXRoIGQ9Ik03IDdoMTB2MTBIN3oiLz48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIyIi8+PC9zdmc+";

// The kit's ModuleType enum is a runtime value ("HW_WALLET"), but statically
// importing the kit here would drag it into the common chunk via wallet.ts's
// lazy ledger-module import. The kit interface only needs the literal, so use
// it directly — pinned by the ModuleType mock in the ledger/wallet tests.

/**
 * Why a Ledger operation failed. Classified from the transport/app error so
 * the UI can tell "the cable was pulled" apart from "you declined on the
 * device" — previously both surfaced as one opaque USB error (issue #1040).
 */
export type LedgerDeviceErrorKind =
  "unsupported" | "unavailable" | "disconnected" | "locked" | "app-closed" | "rejected" | "unknown";

/** Error thrown by every Ledger operation, carrying a classified `kind`. */
export class LedgerDeviceError extends Error {
  kind: LedgerDeviceErrorKind;

  constructor(kind: LedgerDeviceErrorKind, message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = "LedgerDeviceError";
    this.kind = kind;
    if (opts && "cause" in opts) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/**
 * Classify a device/transport error. Order matters: a declined request must be
 * reported as such (and never retried), while "device not open" is a dead
 * transport that reconnecting can fix.
 */
export function classifyLedgerError(e: unknown): LedgerDeviceErrorKind {
  if (e instanceof LedgerDeviceError) return e.kind;
  const message = errorText(e);

  // 0x5515: locked device / PIN not entered.
  if (/0x5515|\blocked\b|enter (your )?pin/i.test(message)) return "locked";
  // 0x6985: the user declined on the device.
  if (/0x6985|\bdenied\b|\brejected\b|\bcancel+ed\b/i.test(message)) return "rejected";
  // 0x6e00 / 0x6d00: the Stellar app isn't the foreground app.
  if (/0x6e00|0x6d00|instruction not (supported|found)|app.*not.*open|stellar app/i.test(message)) {
    return "app-closed";
  }
  if (/not supported|webusb|no transport|transport.*(?:un)?available/i.test(message)) {
    return "unsupported";
  }
  if (
    /no (?:ledger|device)|no .*device (?:was )?found|device not found|device.*not.*(?:found|connected)/i.test(
      message,
    )
  ) {
    return "unavailable";
  }
  if (
    /disconnect|unplug|device.*(?:removed|closed)|not open|cannot open|failed to open|transfer ?error|networkerror/i.test(
      message,
    )
  ) {
    return "disconnected";
  }
  return "unknown";
}

/** Actionable, user-facing sentence for each failure kind. */
export function ledgerDeviceErrorMessage(kind: LedgerDeviceErrorKind): string {
  switch (kind) {
    case "unsupported":
      return "This browser can't reach a Ledger over WebUSB. Use Chrome, Edge or Brave on a desktop computer.";
    case "unavailable":
      return "No Ledger was found over USB. Connect the device, unlock it, and open the Stellar app.";
    case "disconnected":
      return "The Ledger was disconnected. Reconnect it over USB, unlock it, open the Stellar app, and try again.";
    case "locked":
      return "Your Ledger is locked. Enter your PIN on the device, then try again.";
    case "app-closed":
      return "Open the Stellar app on your Ledger, then try again.";
    case "rejected":
      return "The request was declined on the Ledger device.";
    case "unknown":
    default:
      return "The Ledger request failed. Reconnect the device and try again.";
  }
}

function toDeviceError(e: unknown, action: string): LedgerDeviceError {
  const kind = classifyLedgerError(e);
  return new LedgerDeviceError(
    kind,
    `Failed to ${action}: ${ledgerDeviceErrorMessage(kind)} (${errorText(e)})`,
    { cause: e },
  );
}

type DisconnectAwareTransport = TransportWebUSB & {
  on?: (event: "disconnect", listener: () => void) => void;
  off?: (event: "disconnect", listener: () => void) => void;
};

export class LedgerModule implements ModuleInterface {
  id = LEDGER_ID;
  name = LEDGER_NAME;
  icon = LEDGER_ICON;
  type = "hardware" as const;
  url = "https://www.ledger.com";
  async isPlatformWrapper(): Promise<boolean> {
    return false;
  }
  moduleType = "HW_WALLET" as ModuleInterface["moduleType"];
  productId = LEDGER_ID;
  productName = LEDGER_NAME;
  productUrl = "https://www.ledger.com";
  productIcon = LEDGER_ICON;

  private transport: DisconnectAwareTransport | null = null;
  private strApp: Str | null = null;
  private network: WalletNetwork;
  /** In-flight transport open, so concurrent calls share one WebUSB session. */
  private connecting: Promise<void> | null = null;
  private disconnectListener: (() => void) | null = null;
  /** The transport `disconnectListener` was registered on, so it can be
   *  unregistered even after `this.transport` has been cleared. */
  private listenerTransport: DisconnectAwareTransport | null = null;
  private readonly disconnectSubscribers = new Set<() => void>();

  /** Typed accessor past ensureConnection(): keeps Str's real call shapes
   *  (value types rather than `any`) while satisfying the flow analysis. */
  private get app(): Str {
    if (!this.strApp) throw new Error("Ledger is not connected");
    return this.strApp;
  }

  constructor(network: WalletNetwork) {
    this.network = network;
  }

  /** True while a live transport + Stellar app session is held. */
  isConnected(): boolean {
    return this.strApp !== null;
  }

  /**
   * Subscribe to unexpected transport loss (cable pulled, browser revoked the
   * USB permission). Deliberate `disconnect()` calls do not notify. Returns an
   * unsubscribe function.
   */
  onDisconnect(listener: () => void): () => void {
    this.disconnectSubscribers.add(listener);
    return () => {
      this.disconnectSubscribers.delete(listener);
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { default: TransportWebUSB } = await import("@ledgerhq/hw-transport-webusb");
      return await TransportWebUSB.isSupported();
    } catch {
      return false;
    }
  }

  async getAddress(): Promise<{ address: string }> {
    const response = await this.execute("get address from Ledger", (app) =>
      // Str#getPublicKey(path, display?) resolves { rawPublicKey: Buffer } —
      // NOT { publicKey: hexString }. Passing the raw bytes straight to
      // StrKey avoids the double-hex-decoding the old code assumed.
      app.getPublicKey(LEDGER_DEFAULT_PATH, true),
    );
    // Lazy load StrKey from the stellar-sdk bundle so the home page never has
    // to carry the heavy SDK (stellar-sdk + stellar-base) when the ledger
    // module is never used (the wallet picker already excludes it).
    const { StrKey } = await import("@stellar/stellar-sdk");
    return { address: StrKey.encodeEd25519PublicKey(response.rawPublicKey) };
  }

  async signTransaction(
    xdrString: string,
    opts: {
      networkPassphrase?: string;
      address?: string;
      path?: string;
      submit?: boolean;
      submitUrl?: string;
    },
  ): Promise<{ signedTxXdr: string }> {
    if (!opts.address) {
      throw new LedgerDeviceError(
        "unknown",
        "Failed to sign with Ledger: signing requires the signer address (opts.address)",
      );
    }

    const path = opts.path ?? LEDGER_DEFAULT_PATH;
    if (!isValidLedgerPath(path)) {
      throw new LedgerDeviceError(
        "unknown",
        `Failed to sign with Ledger: invalid derivation path "${path}". Use a hardened path such as ${LEDGER_DEFAULT_PATH}.`,
      );
    }

    const { Transaction, StrKey, xdr } = await import("@stellar/stellar-sdk");
    const tx = new Transaction(xdrString, opts.networkPassphrase ?? NETWORK_PASSPHRASE);

    const { signature } = await this.execute("sign with Ledger", (app) =>
      app.signTransaction(path, tx.signatureBase()),
    );

    // Str#signTransaction resolves { signature: Buffer } (raw 64-byte
    // ed25519 signature) — it is already binary, not hex-encoded text.
    const hint = Buffer.from(StrKey.decodeEd25519PublicKey(opts.address)).subarray(-4);

    const decoratedSig = new xdr.DecoratedSignature({ hint, signature });
    tx.signatures.push(decoratedSig);
    return { signedTxXdr: tx.toXDR() };
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    return { network: NETWORK_PASSPHRASE, networkPassphrase: NETWORK_PASSPHRASE };
  }

  /**
   * Run one device operation with transparent recovery from a dropped
   * transport. A disconnect is retried exactly once after reopening the USB
   * session (the device re-asks for approval); a declined, locked or
   * app-closed request is surfaced immediately and never retried, so a user's
   * "no" can't silently turn into a second prompt.
   */
  private async execute<T>(action: string, run: (app: Str) => Promise<T>): Promise<T> {
    let lastError: unknown;
    const MAX_ATTEMPTS = 2;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.ensureConnection();
        return await run(this.app);
      } catch (e) {
        lastError = e;
        if (classifyLedgerError(e) !== "disconnected" || attempt === MAX_ATTEMPTS - 1) {
          break;
        }
        await this.closeTransport();
      }
    }
    throw toDeviceError(lastError, action);
  }

  private async ensureConnection(): Promise<void> {
    if (this.strApp) return;
    if (!this.connecting) {
      this.connecting = this.openTransport().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async openTransport(): Promise<void> {
    try {
      const { default: TransportWebUSB } = await import("@ledgerhq/hw-transport-webusb");
      const { default: StrApp } = await import("@ledgerhq/hw-app-str");

      const transport = (await TransportWebUSB.create()) as DisconnectAwareTransport;
      this.attachDisconnectHandler(transport);
      this.transport = transport;
      this.strApp = new StrApp(transport);
    } catch (e) {
      throw toDeviceError(e, "connect to Ledger");
    }
  }

  /**
   * React to an unexpected transport loss by dropping the cached session, so
   * the next operation opens a fresh one instead of signing over a dead
   * handle. Subscribers (the wallet UI) are told so they can prompt a retry.
   */
  private attachDisconnectHandler(transport: DisconnectAwareTransport): void {
    this.detachDisconnectHandler();
    const listener = () => {
      this.detachDisconnectHandler();
      this.transport = null;
      this.strApp = null;
      for (const subscriber of Array.from(this.disconnectSubscribers)) {
        try {
          subscriber();
        } catch {
          // a broken subscriber must never take down the transport handler
        }
      }
    };
    this.disconnectListener = listener;
    this.listenerTransport = transport;
    try {
      transport.on?.("disconnect", listener);
    } catch {
      // Transport implementations without events simply won't report loss;
      // operations still fail and are classified on their own.
    }
  }

  private detachDisconnectHandler(): void {
    const listener = this.disconnectListener;
    const transport = this.listenerTransport;
    this.disconnectListener = null;
    this.listenerTransport = null;
    if (!listener || !transport) return;
    try {
      transport.off?.("disconnect", listener);
    } catch {
      // ignore
    }
  }

  private async closeTransport(): Promise<void> {
    const transport = this.transport;
    this.detachDisconnectHandler();
    this.transport = null;
    this.strApp = null;
    if (transport) {
      try {
        await transport.close();
      } catch {
        // the transport may already be gone; closing is best-effort
      }
    }
  }

  async disconnect(): Promise<void> {
    await this.closeTransport();
  }

  async signAuthEntry(): Promise<{ signedAuthEntry: string; signerAddress?: string }> {
    throw new Error("Ledger does not support signAuthEntry");
  }

  async signMessage(): Promise<{ signedMessage: string; signerAddress?: string }> {
    throw new Error("Ledger does not support signMessage");
  }
}

/**
 * The kit network that matches a network passphrase. Single source of truth
 * for network selection in the wallet layer (used here and by lib/wallet.ts's
 * kit/WalletConnect config) so the two can't drift: the kit has no futurenet
 * enum, so anything that isn't mainnet signs as testnet.
 */
export function kitNetworkForPassphrase(passphrase: string): WalletNetwork {
  // WalletNetwork enum values ARE the passphrases themselves (PUBLIC =
  // "Public Global Stellar Network ; September 2015", TESTNET = "Test SDF
  // Network ; September 2015") — compare inline as literals so this helper
  // never needs a runtime kit import; callers cast to WalletNetwork.
  return (
    passphrase === "Public Global Stellar Network ; September 2015"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015"
  ) as WalletNetwork;
}

export function getLedgerModule(): LedgerModule {
  return new LedgerModule(kitNetworkForPassphrase(NETWORK_PASSPHRASE));
}
