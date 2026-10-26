"use client";

import { NETWORK_PASSPHRASE } from "./stellar";
import type {
  ModuleInterface,
  WalletNetwork,
} from "@creit.tech/stellar-wallets-kit";
// Runtime type shapes for the Ledger internals. Deliberately type-only: the
// real @ledgerhq/hw-transport entry point isn't a direct dependency of the
// frontend, and TransportWebUSB's instance type carries everything the
// transport field is used for (create()/close()). Keeping these typed is what
// makes the response shapes below (#753) compiler-checked instead of
// runtime-broken behind `any`.
import type TransportWebUSB from "@ledgerhq/hw-transport-webusb";
import type Str from "@ledgerhq/hw-app-str";
import { Buffer } from "buffer";

export const LEDGER_ID = "ledger";
export const LEDGER_NAME = "Ledger";
export const LEDGER_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTMgM2gxOHYxOEgzeiIvPjxwYXRoIGQ9Ik03IDdoMTB2MTBIN3eiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjIiLz48L3N2Zz4=";

// The kit's ModuleType enum is a runtime value ("HW_WALLET"), but statically
// importing the kit here would drag it into the common chunk via wallet.ts's
// lazy ledger-module import. The kit interface only needs the literal, so use
// it directly — pinned by the ModuleType mock in the ledger/wallet tests.

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

  private transport: TransportWebUSB | null = null;
  private strApp: Str | null = null;
  private network: WalletNetwork;

  /** Typed accessor past ensureConnection(): keeps Str's real call shapes
   *  (value types rather than `any`) while satisfying the flow analysis. */
  private get app(): Str {
    if (!this.strApp) throw new Error("Ledger is not connected");
    return this.strApp;
  }

  constructor(network: WalletNetwork) {
    this.network = network;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { default: TransportWebUSB } = await import(
        "@ledgerhq/hw-transport-webusb"
      );
      return await TransportWebUSB.isSupported();
    } catch {
      return false;
    }
  }

  async getAddress(): Promise<{ address: string }> {
    await this.ensureConnection();
    try {
      const path = "44'/148'/0'";
      // Str#getPublicKey(path, display?) resolves { rawPublicKey: Buffer } —
      // NOT { publicKey: hexString }. Passing the raw bytes straight to StrKey
      // avoids the double-hex-decoding the old code assumed.
      const response = await this.app.getPublicKey(path, true);
      // Lazy load StrKey from the stellar-sdk bundle so the home page never has
      // to carry the heavy SDK (stellar-sdk + stellar-base) when the ledger
      // module is never used (the wallet picker already excludes it).
      const { StrKey } = await import("@stellar/stellar-sdk");
      const address = StrKey.encodeEd25519PublicKey(response.rawPublicKey);
      return { address };
    } catch (e) {
      throw new Error(
        `Failed to get address from Ledger: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async signTransaction(
    xdrString: string,
    opts: {
      networkPassphrase?: string;
      address?: string;
      path?: string;
      submit?: boolean;
      submitUrl?: string;
    }
  ): Promise<{ signedTxXdr: string }> {
    await this.ensureConnection();
    try {
      if (!opts.address) {
        throw new Error(
          "Ledger signing requires the signer address (opts.address)"
        );
      }
      const { Transaction, StrKey, xdr } = await import("@stellar/stellar-sdk");
      const tx = new Transaction(
        xdrString,
        opts.networkPassphrase ?? NETWORK_PASSPHRASE
      );
      const path = opts.path ?? "44'/148'/0'";

      const { signature } = await this.app.signTransaction(
        path,
        tx.signatureBase()
      );

      // Str#signTransaction resolves { signature: Buffer } (raw 64-byte
      // ed25519 signature) — it is already binary, not hex-encoded text.
      const hint = Buffer.from(
        StrKey.decodeEd25519PublicKey(opts.address)
      ).subarray(-4);

      const decoratedSig = new xdr.DecoratedSignature({ hint, signature });
      tx.signatures.push(decoratedSig);
      return { signedTxXdr: tx.toXDR() };
    } catch (e) {
      throw new Error(
        `Failed to sign with Ledger: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    return { network: NETWORK_PASSPHRASE, networkPassphrase: NETWORK_PASSPHRASE };
  }

  private async ensureConnection(): Promise<void> {
    if (this.strApp) return;

    try {
      const { default: TransportWebUSB } = await import(
        "@ledgerhq/hw-transport-webusb"
      );
      const { default: StrApp } = await import("@ledgerhq/hw-app-str");

      this.transport = (await TransportWebUSB.create()) as TransportWebUSB;
      this.strApp = new StrApp(this.transport);
    } catch (e) {
      throw new Error(
        `Failed to connect to Ledger: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignore
      }
      this.transport = null;
      this.strApp = null;
    }
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
