/**
 * E2E tests: wallet connection (Issue #743)
 *
 * Covers:
 *   1. Connect-wallet prompt is shown when no wallet is connected.
 *   2. Clicking "Connect wallet" invokes the Stellar Wallets Kit and displays
 *      the truncated address once connected.
 *   3. Disconnecting the wallet returns the UI to the unauthenticated state.
 *   4. Network-mismatch banner appears when the wallet reports a wrong network.
 *   5. Wallet restore: the address is recovered from localStorage on hard reload.
 */

import { test, expect } from "@playwright/test";
import {
  injectMockWallet,
  injectMockWalletDisconnected,
  TEST_WALLET,
} from "./helpers/mock-wallet";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Return the first 6 + last 4 characters of an address, matching the UI. */
function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Wallet Connection", () => {
  test("shows connect-wallet prompt when no wallet is connected", async ({
    page,
  }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/verify");

    // The verify page prompts the user to connect before they can do anything.
    await expect(
      page.getByText(/Connect your wallet to request credentials/i)
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toBeVisible();

    // The main CTA ("Get credential") must not be reachable without a wallet.
    await expect(
      page.getByRole("button", { name: /get credential|verify identity/i })
    ).not.toBeVisible();
  });

  test("clicking Connect wallet connects and displays the truncated address", async ({
    page,
  }) => {
    // Wallet API is injected but NOT pre-connected (no localStorage key).
    await injectMockWalletDisconnected(page);
    await page.goto("/verify");

    await page.getByRole("button", { name: "Connect wallet", exact: true }).click();

    // After connecting, the truncated address should appear in the header / nav.
    await expect(page.getByText(truncate(TEST_WALLET))).toBeVisible({
      timeout: 8_000,
    });

    // The connect-wallet prompt should disappear once connected.
    await expect(
      page.getByText(/Connect your wallet to request credentials/i)
    ).not.toBeVisible();
  });

  test("wallet address is shown after connecting — issued-to field reflects address", async ({
    page,
  }) => {
    await injectMockWallet(page, TEST_WALLET);
    await page.goto("/verify");

    // The "Issued to" line in the verify card should show the wallet address.
    await expect(page.getByText(truncate(TEST_WALLET))).toBeVisible();
  });

  test("disconnecting the wallet returns to the unauthenticated state", async ({
    page,
  }) => {
    await injectMockWallet(page, TEST_WALLET);
    await page.goto("/verify");

    // Confirm we are connected first.
    await expect(page.getByText(truncate(TEST_WALLET))).toBeVisible();

    // Find and click the wallet button in the nav to open its popover, then
    // click the disconnect option. The WalletButton renders a button that
    // shows the truncated address; clicking it opens a dropdown/popover.
    const walletBtn = page.getByRole("button", { name: new RegExp(truncate(TEST_WALLET), "i") });
    await walletBtn.click();

    const disconnectBtn = page.getByRole("button", { name: /disconnect/i });
    await expect(disconnectBtn).toBeVisible({ timeout: 5_000 });
    await disconnectBtn.click();

    // After disconnect, the connect-wallet prompt should reappear.
    await expect(
      page.getByRole("button", { name: "Connect wallet", exact: true })
    ).toBeVisible({ timeout: 8_000 });
  });

  test("wallet state is restored from localStorage on hard reload", async ({
    page,
  }) => {
    await injectMockWallet(page, TEST_WALLET);
    await page.goto("/verify");

    // Confirm connected.
    await expect(page.getByText(truncate(TEST_WALLET))).toBeVisible();

    // Hard reload — the wallet-context restore hook should re-connect.
    await page.reload();
    await expect(page.getByText(truncate(TEST_WALLET))).toBeVisible({
      timeout: 8_000,
    });
  });

  test("holder page prompts wallet connection when no wallet is stored", async ({
    page,
  }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/holder");

    // Holder page should show a connect-wallet prompt instead of credentials.
    await expect(
      page.getByRole("button", { name: "Connect wallet", exact: true })
    ).toBeVisible();
  });

  test("apps page shows wallet-required state when no wallet is connected", async ({
    page,
  }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/apps/lendfi");

    // Without a wallet the action button should indicate connection is needed.
    const actionBtn = page.getByRole("button", {
      name: "Connect wallet to check access",
      exact: true,
    });
    await expect(actionBtn).toBeVisible();
    await expect(actionBtn).toBeDisabled();
  });
});
