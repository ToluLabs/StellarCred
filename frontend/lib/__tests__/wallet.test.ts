// Unit coverage for lib/wallet.ts's kit-agnostic behavior. Real wallet
// extensions/WalletConnect relays aren't available in jsdom (see the note in
// app/verify/__tests__/verify-flow.test.tsx), so StellarWalletsKit and the
// WalletConnect module are mocked; what's under test is StellarCred's own
// logic on top of them — error-kind mapping, per-wallet error context
// (regression guard for a bug where every "not installed" error hardcoded
// "Freighter" regardless of which wallet was actually being connected), and
// whether WalletConnect gets registered based on the project-id env var.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ISupportedWallet, ModuleInterface } from "@creit.tech/stellar-wallets-kit";
import { WalletConnectError, getWalletErrorInfo, getWalletReportUrl } from "../wallet";

interface MockKitInstance {
  modules: ModuleInterface[];
  openModal: ReturnType<typeof vi.fn>;
  setWallet: ReturnType<typeof vi.fn>;
  getAddress: ReturnType<typeof vi.fn>;
  getNetwork: ReturnType<typeof vi.fn>;
  signTransaction: ReturnType<typeof vi.fn>;
}

vi.mock("@creit.tech/stellar-wallets-kit", () => {
  class MockKit implements Partial<MockKitInstance> {
    static lastInstance: MockKit | null = null;
    modules: ModuleInterface[];
    openModal = vi.fn();
    setWallet = vi.fn();
    getAddress = vi.fn();
    getNetwork = vi.fn();
    signTransaction = vi.fn();
    constructor(opts: { modules: ModuleInterface[] }) {
      this.modules = opts.modules;
      MockKit.lastInstance = this;
    }
  }
  return {
    StellarWalletsKit: MockKit,
    WalletNetwork: { PUBLIC: "Public Global Stellar Network ; September 2015", TESTNET: "Test SDF Network ; September 2015" },
    allowAllModules: () => [{ id: "freighter" }, { id: "albedo" }] as unknown as ModuleInterface[],
    FREIGHTER_ID: "freighter",
  };
});

vi.mock("@creit.tech/stellar-wallets-kit/modules/walletconnect.module", () => {
  class MockWalletConnectModule {
    params: Record<string, unknown>;
    constructor(params: Record<string, unknown>) {
      this.params = params;
    }
  }
  return {
    WalletConnectModule: MockWalletConnectModule,
    WalletConnectAllowedMethods: { SIGN: "stellar_signXDR", SIGN_AND_SUBMIT: "stellar_signAndSubmitXDR" },
    WALLET_CONNECT_ID: "wallet_connect",
  };
});

const wallet = (id: string, name: string, url: string): ISupportedWallet => ({
  id,
  name,
  url,
  type: "HOT_WALLET",
  isAvailable: true,
  isPlatformWrapper: false,
  icon: "",
});

describe("lib/wallet.ts", () => {
  let getKit: typeof import("../wallet").getKit;
  let connect: typeof import("../wallet").connect;
  let restore: typeof import("../wallet").restore;
  let signTx: typeof import("../wallet").signTx;
  let getNetworkOk: typeof import("../wallet").getNetworkOk;
  let kit: MockKitInstance;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../wallet");
    ({ getKit, connect, restore, signTx, getNetworkOk } = mod);
    kit = getKit() as unknown as MockKitInstance;
  });

  describe("connect", () => {
    it("resolves the address and walletId of whichever wallet the user picked", async () => {
      kit.openModal.mockImplementation(async ({ onWalletSelected }: { onWalletSelected: (w: ISupportedWallet) => Promise<void> }) => {
        kit.getAddress.mockResolvedValue({ address: "GALBEDOADDRESS" });
        await onWalletSelected(wallet("albedo", "Albedo", "https://albedo.link"));
      });

      await expect(connect()).resolves.toEqual({ address: "GALBEDOADDRESS", walletId: "albedo" });
      expect(kit.setWallet).toHaveBeenCalledWith("albedo");
    });

    it("rejects as dismissed when the modal is closed without a selection", async () => {
      kit.openModal.mockImplementation(({ onClosed }: { onClosed: (e: Error) => void }) => {
        onClosed(new Error("closed"));
      });

      await expect(connect()).rejects.toMatchObject({ kind: "dismissed" });
    });

    it("carries the selected wallet's own name/url on a not-installed failure — not a hardcoded wallet", async () => {
      kit.openModal.mockImplementation(async ({ onWalletSelected }: { onWalletSelected: (w: ISupportedWallet) => Promise<void> }) => {
        kit.getAddress.mockRejectedValue(new Error("Wallet is not available"));
        await onWalletSelected(wallet("xbull", "xBull", "https://xbull.app"));
      });

      await expect(connect()).rejects.toMatchObject({
        kind: "not-installed",
        walletName: "xBull",
        installUrl: "https://xbull.app",
      });
    });

    it("maps a different wallet's not-installed failure to that wallet, not the previous one", async () => {
      kit.openModal.mockImplementation(async ({ onWalletSelected }: { onWalletSelected: (w: ISupportedWallet) => Promise<void> }) => {
        kit.getAddress.mockRejectedValue(new Error("not connected"));
        await onWalletSelected(wallet("lobstr", "Lobstr", "https://lobstr.co"));
      });

      await expect(connect()).rejects.toMatchObject({
        kind: "not-installed",
        walletName: "Lobstr",
        installUrl: "https://lobstr.co",
      });
    });

    it("maps WalletConnect's own 'not connected' relay failures to rejected, not not-installed", async () => {
      // WalletConnect isn't a browser extension — "not connected" here means a
      // dropped relay socket or expired session, not something to "install".
      kit.openModal.mockImplementation(async ({ onWalletSelected }: { onWalletSelected: (w: ISupportedWallet) => Promise<void> }) => {
        kit.getAddress.mockRejectedValue(new Error("not connected"));
        await onWalletSelected(wallet("wallet_connect", "WalletConnect", "https://walletconnect.com"));
      });

      const rejection = await connect().catch((e) => e);
      expect(rejection).toMatchObject({ kind: "rejected" });
      expect(rejection.installUrl).toBeUndefined();
    });

    it("maps any other selection failure to rejected (treated as user cancellation)", async () => {
      kit.openModal.mockImplementation(async ({ onWalletSelected }: { onWalletSelected: (w: ISupportedWallet) => Promise<void> }) => {
        kit.getAddress.mockRejectedValue(new Error("User declined access"));
        await onWalletSelected(wallet("freighter", "Freighter", "https://freighter.app"));
      });

      await expect(connect()).rejects.toMatchObject({ kind: "rejected" });
    });
  });

  describe("restore", () => {
    it("re-selects the wallet by id (no modal) and returns its address", async () => {
      kit.getAddress.mockResolvedValue({ address: "GRESTORED" });

      await expect(restore("xbull")).resolves.toBe("GRESTORED");
      expect(kit.setWallet).toHaveBeenCalledWith("xbull");
    });
  });

  describe("signTx", () => {
    it("delegates to the kit and returns the signed xdr", async () => {
      kit.signTransaction.mockResolvedValue({ signedTxXdr: "SIGNED_XDR" });

      await expect(signTx("RAW_XDR", "GADDR")).resolves.toBe("SIGNED_XDR");
      expect(kit.signTransaction).toHaveBeenCalledWith(
        "RAW_XDR",
        expect.objectContaining({ address: "GADDR" }),
      );
    });
  });

  describe("getNetworkOk", () => {
    it("returns true when the wallet's network passphrase matches", async () => {
      kit.getNetwork.mockResolvedValue({ networkPassphrase: "Test SDF Network ; September 2015" });
      await expect(getNetworkOk()).resolves.toBe(true);
    });

    it("returns false on a network mismatch", async () => {
      kit.getNetwork.mockResolvedValue({ networkPassphrase: "Public Global Stellar Network ; September 2015" });
      await expect(getNetworkOk()).resolves.toBe(false);
    });

    it("returns true (no false positive) when the wallet doesn't support getNetwork", async () => {
      kit.getNetwork.mockRejectedValue(new Error("not supported"));
      await expect(getNetworkOk()).resolves.toBe(true);
    });
  });
});

// Each WalletErrorKind must produce a distinct, actionable message, and
// user-cancellation (dismissed/rejected) must be flagged benign (not shown as a
// hard error). This pins the copy the UI renders per kind.
describe("lib/wallet.ts getWalletErrorInfo() per-kind error mapping", () => {
  it("maps not-installed to an install prompt with a pick-another-wallet nudge", () => {
    const err = new WalletConnectError("not-installed", "xBull isn't available. Install it to continue.", {
      walletName: "xBull",
      installUrl: "https://xbull.app",
    });
    const info = getWalletErrorInfo(err);
    expect(info.benign).toBe(false);
    expect(info.action).toBe("install");
    expect(info.title).toMatch(/not installed/i);
    expect(info.message).toContain("xBull");
    expect(info.message.toLowerCase()).toMatch(/pick another wallet/i);
  });

  it("maps not-installed without a wallet to a generic install message", () => {
    const info = getWalletErrorInfo(new WalletConnectError("not-installed", "No wallet"));
    expect(info.message).toMatch(/pick another wallet/i);
  });

  it("maps dismissed to a benign 'you cancelled — try again' note", () => {
    const info = getWalletErrorInfo(new WalletConnectError("dismissed", "Connection cancelled"));
    expect(info.benign).toBe(true);
    expect(info.action).toBe("retry");
    expect(info.title).toMatch(/cancelled/i);
    expect(info.message.toLowerCase()).toMatch(/try again/i);
  });

  it("maps rejected to a benign 'declined — try again' note", () => {
    const info = getWalletErrorInfo(new WalletConnectError("rejected", "Connection cancelled"));
    expect(info.benign).toBe(true);
    expect(info.action).toBe("retry");
    expect(info.title).toMatch(/declined/i);
    expect(info.message.toLowerCase()).toMatch(/try again/i);
  });

  it("maps timeout to a distinct 'wallet didn't respond — retry' message (a hard error)", () => {
    const info = getWalletErrorInfo(new WalletConnectError("timeout", "Connection timed out"));
    expect(info.benign).toBe(false);
    expect(info.action).toBe("retry");
    expect(info.title).toMatch(/didn't respond/i);
    expect(info.message.toLowerCase()).toMatch(/try again/i);
  });

  it("maps unknown to a generic message plus a way to report", () => {
    const info = getWalletErrorInfo(new WalletConnectError("unknown", "Something went wrong"));
    expect(info.benign).toBe(false);
    expect(info.action).toBe("retry-report");
    expect(info.title).toMatch(/something went wrong/i);
    expect(info.message.toLowerCase()).toMatch(/report/i);
  });

  it("treats any unrecognized kind as unknown", () => {
    const err = { kind: "entirely-unrecognized" } as unknown as WalletConnectError;
    const info = getWalletErrorInfo(err);
    expect(info.action).toBe("retry-report");
  });

  it("getWalletReportUrl returns a pre-filled GitHub issue link for the repo", () => {
    const url = getWalletReportUrl();
    expect(url).toMatch(/^https:\/\/github\.com\/ToluLabs\/StellarCred\/issues\/new/);
    expect(url).toContain("labels=bug");
    expect(new URL(url).searchParams.get("title")).toContain("Wallet connection failed");
  });
});

describe("lib/wallet.ts getKit() WalletConnect module wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("omits WalletConnect from the picker when no project id is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "");
    vi.resetModules();
    const { getKit } = await import("../wallet");
    const { WalletConnectModule } = await import("@creit.tech/stellar-wallets-kit/modules/walletconnect.module");

    const modules = (getKit() as unknown as MockKitInstance).modules;
    expect(modules.some((m) => m instanceof WalletConnectModule)).toBe(false);
  });

  it("registers a WalletConnectModule (with that project id) when configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "test-project-id");
    vi.resetModules();
    const { getKit } = await import("../wallet");
    const { WalletConnectModule } = await import("@creit.tech/stellar-wallets-kit/modules/walletconnect.module");

    const modules = (getKit() as unknown as MockKitInstance).modules;
    const wc = modules.find((m) => m instanceof WalletConnectModule) as unknown as { params: { projectId: string } } | undefined;
    expect(wc).toBeDefined();
    expect(wc?.params.projectId).toBe("test-project-id");
  });
});
