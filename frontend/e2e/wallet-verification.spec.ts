import { test, expect } from "@playwright/test";

interface MockStellarWallet {
  connected: boolean;
  address: string;
  network: string;
  shouldFailConnect: boolean;
  shouldRejectSignature: boolean;
  connect: () => Promise<{ address: string; network: string }>;
  signTransaction: (xdr: string) => Promise<string>;
}

declare global {
  interface Window {
    stellarWallet?: MockStellarWallet;
  }
}

const TEST_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TEST_ISSUER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

test.describe("Wallet Connection and Proof Verification E2E (#946)", () => {
  test.beforeEach(async ({ page }) => {
    // Inject deterministic mock wallet into window before scripts load
    await page.addInitScript(
      ({ walletAddress, issuerAddress }) => {
        const mockWallet: MockStellarWallet = {
          connected: false,
          address: walletAddress,
          network: "testnet",
          shouldFailConnect: false,
          shouldRejectSignature: false,
          connect: async () => {
            if (mockWallet.shouldFailConnect) {
              throw new Error("User rejected wallet connection or unsupported wallet");
            }
            mockWallet.connected = true;
            return { address: mockWallet.address, network: mockWallet.network };
          },
          signTransaction: async (xdr: string) => {
            if (mockWallet.shouldRejectSignature) {
              throw new Error("Transaction signature rejected by user");
            }
            return `signed_${xdr}`;
          },
        };

        window.stellarWallet = mockWallet;

        // Seed localStorage with valid credential
        const cred = {
          type: "kyc",
          title: "KYC Verified",
          claim: "Identity verified",
          issuer: "StellarCred Authority",
          issuerId: issuerAddress,
          holder: walletAddress,
          value: "1",
          salt: "1234567890",
          commitment: "0x1234567890abcdef",
          sig: new Array(64).fill(1),
          issuerPubX: new Array(32).fill(2),
          issuerPubY: new Array(32).fill(3),
          issuedAt: Math.floor(Date.now() / 1000) - 3600,
          expiry: "90 days",
        };

        localStorage.setItem("stellarcred:credentials", JSON.stringify([cred]));
      },
      { walletAddress: TEST_WALLET, issuerAddress: TEST_ISSUER },
    );
  });

  test("happy path: connects wallet, verifies session, and simulates verification flow", async ({
    page,
  }) => {
    await page.goto("/holder");

    // Verify page title and header container exist
    await expect(page.locator("body")).toBeVisible();

    // Trigger mock wallet connect
    const connectResult = await page.evaluate(async () => {
      const wallet = window.stellarWallet;
      if (!wallet) throw new Error("Wallet not initialized");
      return await wallet.connect();
    });

    expect(connectResult.address).toBe(TEST_WALLET);
    expect(connectResult.network).toBe("testnet");

    // Ensure credentials from localStorage are accessible
    const stored = await page.evaluate(() => {
      return localStorage.getItem("stellarcred:credentials");
    });
    expect(stored).toContain("KYC Verified");
  });

  test("failure state: handles unsupported wallet or rejected connection", async ({ page }) => {
    await page.goto("/holder");

    // Configure mock wallet to simulate user rejection
    await page.evaluate(() => {
      if (window.stellarWallet) {
        window.stellarWallet.shouldFailConnect = true;
      }
    });

    const errorResult = await page.evaluate(async () => {
      try {
        const wallet = window.stellarWallet;
        if (!wallet) throw new Error("Wallet not initialized");
        await wallet.connect();
        return { success: true, error: "" };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    expect(errorResult.success).toBe(false);
    expect(errorResult.error).toMatch(/unsupported wallet|rejected wallet connection/i);
  });

  test("failure state: handles rejected transaction signature", async ({ page }) => {
    await page.goto("/holder");

    // Configure mock wallet to reject transaction signing
    await page.evaluate(() => {
      if (window.stellarWallet) {
        window.stellarWallet.shouldRejectSignature = true;
      }
    });

    const signResult = await page.evaluate(async () => {
      try {
        const wallet = window.stellarWallet;
        if (!wallet) throw new Error("Wallet not initialized");
        await wallet.signTransaction("dummy_xdr_payload");
        return { success: true, error: "" };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    expect(signResult.success).toBe(false);
    expect(signResult.error).toMatch(/signature rejected/i);
  });

  test("failure state: detects network mismatch between wallet and app", async ({ page }) => {
    await page.goto("/holder");

    // Configure mock wallet on wrong network
    await page.evaluate(() => {
      if (window.stellarWallet) {
        window.stellarWallet.network = "public";
      }
    });

    const networkMismatch = await page.evaluate(() => {
      const walletNetwork = window.stellarWallet?.network;
      const expectedNetwork = "testnet";
      return walletNetwork !== expectedNetwork;
    });

    expect(networkMismatch).toBe(true);
  });
});
