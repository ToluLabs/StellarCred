// Unit coverage for lib/ledger-module.ts (issue #753 — incorrect types in the
// Ledger signing path).
//
// `LedgerModule` previously hid its transport/Str app behind `any`, which let
// two wrong response shapes slip in: `Str#getPublicKey` resolves
// `{ rawPublicKey: Buffer }` (not `{ publicKey: hexString }`) and
// `Str#signTransaction` resolves `{ signature: Buffer }` (a raw 64-byte
// ed25519 signature, not hex text). These tests pin both shapes at the
// boundary with the real stellar-sdk: a genuine Transaction is built, the
// mocked device signs its `signatureBase()` with a real ed25519 key, and the
// returned XDR must decode to the same transaction with that exact
// signature + hint appended.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WalletNetwork } from "@creit.tech/stellar-wallets-kit";
import {
  Account,
  Asset,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// ── Ledger device mocks (hoisted so vi.mock factories can reference them) ────

const { strGetPublicKey, strSignTransaction, device } = vi.hoisted(() => ({
  strGetPublicKey: vi.fn(),
  strSignTransaction: vi.fn(),
  device: {
    close: vi.fn(),
    lastTransport: null as unknown,
    disconnectListeners: new Set<() => void>(),
  },
}));

vi.mock("@ledgerhq/hw-app-str", () => {
  class FakeStr {
    lastTransport: unknown;
    constructor(transport: unknown) {
      this.lastTransport = transport;
      device.lastTransport = transport;
    }
    getPublicKey = strGetPublicKey;
    signTransaction = strSignTransaction;
  }
  return { default: FakeStr };
});

vi.mock("@ledgerhq/hw-transport-webusb", () => {
  class FakeTransportWebUSB {
    close = device.close;
    // Mirrors Transport's event API: the module subscribes to "disconnect" so
    // a pulled cable clears the cached session instead of reusing it.
    on(event: string, listener: () => void) {
      if (event === "disconnect") device.disconnectListeners.add(listener);
    }
    off(event: string, listener: () => void) {
      if (event === "disconnect") device.disconnectListeners.delete(listener);
    }
    static isSupported = vi.fn(async () => true);
    static create = vi.fn(async () => new FakeTransportWebUSB());
  }
  return { default: FakeTransportWebUSB };
});

// The real kit package can't resolve its freighter dep under vitest (see
// lib/__tests__/wallet.test.ts, which mocks it the same way) — only the
// module-type constants matter at runtime here.
vi.mock("@creit.tech/stellar-wallets-kit", () => ({
  ModuleType: { HW_WALLET: "HW_WALLET" },
  WalletNetwork: {
    PUBLIC: "Public Global Stellar Network ; September 2015",
    TESTNET: "Test SDF Network ; September 2015",
  },
  allowAllModules: () => [],
  FREIGHTER_ID: "freighter",
}));

import {
  LedgerDeviceError,
  LedgerModule,
  LEDGER_ID,
  classifyLedgerError,
  ledgerDeviceErrorMessage,
} from "../ledger-module";
import { LEDGER_DEFAULT_PATH, deriveLedgerPath, parseLedgerPath } from "../ledger-guide";

/** Simulate the browser/device dropping the USB session. */
function emitDeviceDisconnect() {
  for (const listener of Array.from(device.disconnectListeners)) listener();
}

// Test constants. The enum literal is passed by value so nothing besides the
// mocked constants above is needed.
const TEST_NET = "Test SDF Network ; September 2015" as unknown as WalletNetwork;
const DEVICE_PATH = "44'/148'/0'";
const HIDDEN_PATH = "55'/148'/2'";

/** The key "on the device" that produces the raw public key and signature. */
const signer = Keypair.random();
// A second, unrelated address supplied in the sign options (from the kit).
const optionsAddress = Keypair.random().publicKey();

function buildTx(passphrase = TEST_NET): Transaction {
  return new TransactionBuilder(
    new Account(Keypair.random().publicKey(), "1"),
    { fee: "100", networkPassphrase: passphrase },
  )
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1.5",
      }),
    )
    .setTimeout(60)
    .build();
}

function makeModule(): LedgerModule {
  return new LedgerModule(TEST_NET);
}

describe("LedgerModule typed signing (#753)", () => {
  beforeEach(() => {
    strGetPublicKey.mockReset();
    strSignTransaction.mockReset();
    device.close.mockReset();
    device.close.mockResolvedValue({});
    device.disconnectListeners.clear();

    // Device behavior per the real @ledgerhq/hw-app-str Str class contracts:
    //   getPublicKey(path, display?) → { rawPublicKey: Buffer }
    //   signTransaction(path, base)  → { signature: Buffer }  (raw bytes)
    strGetPublicKey.mockResolvedValue({
      rawPublicKey: Buffer.from(signer.rawPublicKey()),
    });
    strSignTransaction.mockImplementation(
      async (_path: string, base: Buffer) => ({
        signature: Buffer.from(signer.sign(base)),
      }),
    );
  });

  it("registers with the wallet-kit hw id", () => {
    expect(LEDGER_ID).toBe("ledger");
    expect(makeModule().id).toBe(LEDGER_ID);
  });

  it("getAddress encodes the raw device public-key Buffer with StrKey", async () => {
    const mod = makeModule();
    const { address } = await mod.getAddress();

    expect(strGetPublicKey).toHaveBeenCalledWith(DEVICE_PATH, true);
    expect(address).toBe(signer.publicKey());
  });

  it("signTransaction attaches the device signature over signatureBase and returns serialisable XDR", async () => {
    const tx = buildTx();
    const xdrIn = tx.toXDR();
    const base = tx.signatureBase();

    const mod = makeModule();
    const { signedTxXdr } = await mod.signTransaction(xdrIn, {
      address: optionsAddress,
      networkPassphrase: TEST_NET,
    });

    // Device received the exact signature base for the default derivation path.
    expect(strSignTransaction).toHaveBeenCalledWith(DEVICE_PATH, base);

    // Output decodes to the identical transaction, with the device signature
    // appended (exactly the bytes the device returned) and the correct hint
    // (last 4 bytes of the options address).
    const out = new Transaction(signedTxXdr, TEST_NET);
    expect(out.signatures.length).toBe(tx.signatures.length + 1);

    const appended = out.signatures[out.signatures.length - 1] as {
      signature(): Buffer;
      hint(): Buffer;
    };
    const expectedSignature = Buffer.from(signer.sign(base));
    expect(appended.signature()).toEqual(expectedSignature);
    expect(appended.hint()).toEqual(
      Buffer.from(StrKey.decodeEd25519PublicKey(optionsAddress)).subarray(-4),
    );

    // and nothing else changed about the tx itself.
    expect(out.signatureBase()).toEqual(base);
    expect(signedTxXdr).not.toBe(xdrIn); // signatures were persisted
  });

  it("signTransaction honours an explicit path from the SEP-43 options", async () => {
    const tx = buildTx();

    const mod = makeModule();
    await mod.signTransaction(tx.toXDR(), {
      address: optionsAddress,
      networkPassphrase: TEST_NET,
      path: HIDDEN_PATH,
    });

    expect(strSignTransaction.mock.calls[0]?.[0]).toBe(HIDDEN_PATH);
  });

  it("signTransaction rejects when no signer address was provided", async () => {
    const mod = makeModule();
    await expect(
      mod.signTransaction(buildTx().toXDR(), {
        networkPassphrase: TEST_NET,
      }),
    ).rejects.toThrow(/signer address/i);
    expect(strSignTransaction).not.toHaveBeenCalled();
  });

  it("wraps device connection failures", async () => {
    strGetPublicKey.mockRejectedValue(new Error("0x6b0c: device not open"));
    const mod = makeModule();
    await expect(mod.getAddress()).rejects.toThrow(
      /Failed to get address from Ledger.*device not open/i,
    );
  });

  it("wraps device signing failures", async () => {
    strSignTransaction.mockRejectedValue(new Error("0x6985: rejected"));
    const mod = makeModule();
    await expect(
      mod.signTransaction(buildTx().toXDR(), {
        address: optionsAddress,
        networkPassphrase: TEST_NET,
      }),
    ).rejects.toThrow(/Failed to sign with Ledger.*rejected/i);
  });

  it("disconnect closes the transport and reconnects cleanly afterwards", async () => {
    const mod = makeModule();
    await mod.getAddress(); // connects
    device.close.mockResolvedValue({});
    await mod.disconnect();
    expect(device.close).toHaveBeenCalledTimes(1);

    // Next action reconnects: a fresh Str app over a fresh transport is built.
    device.lastTransport = null;
    await mod.getAddress();
    expect(device.lastTransport).not.toBeNull();
  });
});

// Issue #1040: a dropped USB session used to surface as an opaque transport
// error and left the module holding a dead Str app, so every later signature
// failed with the same message until a full page reload.
describe("LedgerModule connection recovery (#1040)", () => {
  beforeEach(() => {
    strGetPublicKey.mockReset();
    strSignTransaction.mockReset();
    device.close.mockReset();
    device.close.mockResolvedValue({});
    device.disconnectListeners.clear();

    strGetPublicKey.mockResolvedValue({
      rawPublicKey: Buffer.from(signer.rawPublicKey()),
    });
    strSignTransaction.mockImplementation(async (_path: string, base: Buffer) => ({
      signature: Buffer.from(signer.sign(base)),
    }));
  });

  it("reopens the transport and retries once after a disconnect", async () => {
    strGetPublicKey
      .mockRejectedValueOnce(new Error("DisconnectedDevice: device disconnected"))
      .mockResolvedValueOnce({ rawPublicKey: Buffer.from(signer.rawPublicKey()) });

    const mod = makeModule();
    const { address } = await mod.getAddress();

    expect(strGetPublicKey).toHaveBeenCalledTimes(2);
    expect(device.close).toHaveBeenCalledTimes(1);
    expect(address).toBe(signer.publicKey());
    expect(mod.isConnected()).toBe(true);
  });

  it("never retries a request the user declined on the device", async () => {
    strSignTransaction.mockRejectedValue(new Error("0x6985: denied by user"));

    const mod = makeModule();
    await expect(
      mod.signTransaction(buildTx().toXDR(), {
        address: optionsAddress,
        networkPassphrase: TEST_NET,
      }),
    ).rejects.toThrow(/Failed to sign with Ledger.*declined/i);

    // Exactly one prompt: a declined signature must not turn into a second one.
    expect(strSignTransaction).toHaveBeenCalledTimes(1);
  });

  it("classifies each transport failure with its own actionable message", async () => {
    expect(classifyLedgerError(new Error("0x5515: locked"))).toBe("locked");
    expect(classifyLedgerError(new Error("0x6e00: instruction not supported"))).toBe("app-closed");
    expect(classifyLedgerError(new Error("0x6985: condition of use not satisfied"))).toBe("rejected");
    expect(classifyLedgerError(new Error("DisconnectedDeviceDuringOperation"))).toBe("disconnected");
    expect(classifyLedgerError(new Error("No Ledger device found"))).toBe("unavailable");
    expect(classifyLedgerError(new Error("WebUSB not supported"))).toBe("unsupported");

    for (const kind of [
      "locked",
      "app-closed",
      "rejected",
      "disconnected",
      "unavailable",
      "unsupported",
    ] as const) {
      expect(ledgerDeviceErrorMessage(kind).length).toBeGreaterThan(20);
    }
  });

  it("throws a LedgerDeviceError carrying the classified kind", async () => {
    strGetPublicKey.mockRejectedValue(new Error("0x5515: device locked"));

    const mod = makeModule();
    const error = await mod.getAddress().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LedgerDeviceError);
    expect((error as LedgerDeviceError).kind).toBe("locked");
    expect((error as LedgerDeviceError).message).toMatch(/enter your pin/i);
  });

  it("notifies subscribers and clears the session when the transport disconnects", async () => {
    const mod = makeModule();
    await mod.getAddress();
    expect(mod.isConnected()).toBe(true);

    const onDisconnect = vi.fn();
    const unsubscribe = mod.onDisconnect(onDisconnect);

    emitDeviceDisconnect();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(mod.isConnected()).toBe(false);

    unsubscribe();
    emitDeviceDisconnect();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("signs again after a reconnect without a page reload", async () => {
    const mod = makeModule();
    await mod.getAddress();
    emitDeviceDisconnect();

    const tx = buildTx();
    const { signedTxXdr } = await mod.signTransaction(tx.toXDR(), {
      address: optionsAddress,
      networkPassphrase: TEST_NET,
    });

    expect(new Transaction(signedTxXdr, TEST_NET).signatures.length).toBe(1);
    expect(mod.isConnected()).toBe(true);
  });

  it("rejects a malformed derivation path before touching the device", async () => {
    const mod = makeModule();
    await expect(
      mod.signTransaction(buildTx().toXDR(), {
        address: optionsAddress,
        networkPassphrase: TEST_NET,
        path: "44/148/0",
      }),
    ).rejects.toThrow(/invalid derivation path/i);

    expect(strSignTransaction).not.toHaveBeenCalled();
  });
});

describe("Ledger derivation paths (SEP-0005, #1040)", () => {
  it("defaults to 44'/148'/0'", () => {
    expect(LEDGER_DEFAULT_PATH).toBe("44'/148'/0'");
    expect(deriveLedgerPath()).toBe(LEDGER_DEFAULT_PATH);
  });

  it("hardens every component of the path", () => {
    expect(deriveLedgerPath(7)).toBe("44'/148'/7'");
    expect(parseLedgerPath("44'/148'/7'")).toEqual({ purpose: 44, coinType: 148, accountIndex: 7 });
  });

  it("rejects unhardened, incomplete or non-numeric paths", () => {
    expect(parseLedgerPath("44/148/0")).toBeNull();
    expect(parseLedgerPath("44'/148'")).toBeNull();
    expect(parseLedgerPath("44'/148'/abc'")).toBeNull();
    expect(parseLedgerPath("m/44'/148'/0'")).toBeNull();
  });

  it("rejects an account index outside the hardened range", () => {
    expect(() => deriveLedgerPath(-1)).toThrow(RangeError);
    expect(() => deriveLedgerPath(2 ** 31)).toThrow(RangeError);
    expect(() => deriveLedgerPath(1.5)).toThrow(RangeError);
  });
});
