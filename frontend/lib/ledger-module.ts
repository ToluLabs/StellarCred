"use client";

import {
  ModuleInterface,
  ModuleType,
  WalletNetwork,
} from "@creit.tech/stellar-wallets-kit";
import { StrKey } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "./stellar";
import { xdr } from "@stellar/stellar-sdk";

export const LEDGER_ID = "ledger";
export const LEDGER_NAME = "Ledger";
export const LEDGER_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwMDAwIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTMgM2gxOHYxOEgzeiIvPjxwYXRoIGQ9Ik03IDdoMTB2MTBIN3eiIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjIiLz48L3N2Zz4=";

export class LedgerModule implements ModuleInterface {
  id = LEDGER_ID;
  name = LEDGER_NAME;
  icon = LEDGER_ICON;
  type = "hardware" as const;
  url = "https://www.ledger.com";
  async isPlatformWrapper(): Promise<boolean> {
    return false;
  }
  moduleType = ModuleType.HW_WALLET;
  productId = LEDGER_ID;
  productName = LEDGER_NAME;
  productUrl = "https://www.ledger.com";
  productIcon = LEDGER_ICON;

  private transport: any = null;
  private strApp: any = null;
  private network: WalletNetwork;

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
      const response = await this.strApp.getPublicKey(path, true, false);
      const rawPubKey = response.publicKey;
      const address = StrKey.encodeEd25519PublicKey(
        Buffer.from(rawPubKey, "hex")
      );
      return { address };
    } catch (e) {
      throw new Error(
        `Failed to get address from Ledger: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  async signTransaction(
    xdrString: string,
    opts: { address: string; networkPassphrase: string }
  ): Promise<{ signedTxXdr: string }> {
    await this.ensureConnection();
    try {
      const { Transaction } = await import("@stellar/stellar-sdk");
      const tx = new Transaction(xdrString, opts.networkPassphrase);
      const path = "44'/148'/0'";

      const sig = await this.strApp.signTransaction(
        path,
        tx.signatureBase()
      );

      const signature = Buffer.from(sig.signature, "hex");
      const hint = Buffer.from(StrKey.decodeEd25519PublicKey(opts.address)).subarray(-4);

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

      this.transport = await TransportWebUSB.create();
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

export function getLedgerModule(): LedgerModule {
  const network =
    NETWORK_PASSPHRASE === "Public Global Stellar Network ; September 2015"
      ? WalletNetwork.PUBLIC
      : WalletNetwork.TESTNET;
  return new LedgerModule(network);
}
