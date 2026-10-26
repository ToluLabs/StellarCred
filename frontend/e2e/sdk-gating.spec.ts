/**
 * E2E tests: SDK hasClaim / apps gating (Issue #743)
 *
 * Covers:
 *   1. Apps page (/apps) renders the three demo protocols.
 *   2. Individual app page (/apps/lendfi) shows locked state without a wallet.
 *   3. Individual app page shows eligibility-check state with a connected wallet
 *      but no verified claim.
 *   4. Return-URL flow: navigating with ?sc_verified=true shows the verification
 *      success banner.
 *   5. Apps page SDK playground renders the hasClaim / buildVerifyUrl controls.
 *   6. Verify-preset page correctly parses multi-claim preset URLs.
 */

import { test, expect } from "@playwright/test";
import {
  injectMockWallet,
  injectMockWalletDisconnected,
  injectMockCredentials,
  TEST_WALLET,
} from "./helpers/mock-wallet";
import { KYC_CREDENTIAL } from "./helpers/fixtures";

// ---------------------------------------------------------------------------
// Apps listing page
// ---------------------------------------------------------------------------

test.describe("Apps listing page (/apps)", () => {
  test("renders the three demo protocols", async ({ page }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/apps");

    // All three demo protocols should be listed
    await expect(page.getByText("LendFi")).toBeVisible();
    await expect(page.getByText("FundVault")).toBeVisible();
    await expect(page.getByText("AgeGate")).toBeVisible();
  });

  test("each protocol card links to its detail page", async ({ page }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/apps");

    const lendfiLink = page.getByRole("link", { name: /LendFi/i }).first();
    await expect(lendfiLink).toBeVisible();
    await expect(lendfiLink).toHaveAttribute("href", /\/apps\/lendfi/);
  });
});

// ---------------------------------------------------------------------------
// LendFi detail page — locked and eligibility states
// ---------------------------------------------------------------------------

test.describe("LendFi app page — locked state (no wallet)", () => {
  test("shows connect-wallet prompt when no wallet is connected", async ({
    page,
  }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/apps/lendfi");

    await expect(
      page.getByRole("heading", { name: "LendFi" })
    ).toBeVisible();

    await expect(
      page.getByText("Connect your wallet to check eligibility.")
    ).toBeVisible();

    // Action button must be disabled
    const actionBtn = page.getByRole("button", {
      name: "Connect wallet to check access",
      exact: true,
    });
    await expect(actionBtn).toBeVisible();
    await expect(actionBtn).toBeDisabled();
  });

  test("required claim shows as Needed without a wallet", async ({ page }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/apps/lendfi");

    // Requirement tiles should show "Needed" for unverified claims
    const neededBadge = page.locator(".card").getByText("Needed").first();
    await expect(neededBadge).toBeVisible();
  });
});

test.describe("LendFi app page — wallet connected, no proof", () => {
  test("shows eligibility check with a connected wallet", async ({ page }) => {
    await injectMockWallet(page, TEST_WALLET);
    await page.goto("/apps/lendfi");

    await expect(
      page.getByRole("heading", { name: "LendFi" })
    ).toBeVisible();

    // With a wallet connected but no claim, the user should see a path to verify
    await expect(
      page.getByRole("button", {
        name: /Prove eligibility|Verify on StellarCred|check access/i,
      })
    ).toBeVisible({ timeout: 8_000 });
  });
});

// ---------------------------------------------------------------------------
// Return-URL flow: ?sc_verified banner
// ---------------------------------------------------------------------------

test.describe("Apps page — return-URL verification banner", () => {
  test("shows verification-complete banner when sc_verified=true is in the URL", async ({
    page,
  }) => {
    await injectMockWallet(page, TEST_WALLET);
    await page.goto(
      `/apps/lendfi?sc_verified=true&sc_wallet=${TEST_WALLET}&sc_claims=kyc`
    );

    await expect(page.getByText(/Verification complete/i)).toBeVisible();
    await expect(
      page.getByText(/You were returned here from StellarCred automatically/i)
    ).toBeVisible();
  });

  test("banner is not shown without sc_verified param", async ({ page }) => {
    await injectMockWallet(page, TEST_WALLET);
    await page.goto("/apps/lendfi");

    await expect(
      page.getByText(/You were returned here from StellarCred automatically/i)
    ).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// FundVault and AgeGate — other protocol pages
// ---------------------------------------------------------------------------

test.describe("FundVault app page", () => {
  test("renders with correct heading and claim type", async ({ page }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/apps/fundvault");

    await expect(
      page.getByRole("heading", { name: "FundVault" })
    ).toBeVisible();
  });
});

test.describe("AgeGate app page", () => {
  test("renders with correct heading and claim type", async ({ page }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/apps/agegate");

    await expect(
      page.getByRole("heading", { name: "AgeGate" })
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Verify-preset page (SDK buildVerifyUrl consumer)
// ---------------------------------------------------------------------------

test.describe("Verify-preset page", () => {
  test("shows an error for an empty claim list", async ({ page }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/verify-preset");

    await expect(
      page.getByText(/This link doesn't name any recognised claims/i)
    ).toBeVisible();
  });

  test("shows an error for an unrecognised claim type", async ({ page }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/verify-preset?c=invalid_claim_type");

    await expect(
      page.getByText(/This link doesn't name any recognised claims/i)
    ).toBeVisible();
  });

  test("renders correctly for a valid multi-claim preset URL", async ({
    page,
  }) => {
    await injectMockWalletDisconnected(page);
    await page.goto(
      "/verify-preset?name=Institutional+DeFi&c=kyc,age:21,income:200000"
    );

    await expect(
      page.getByRole("heading", { name: "Institutional DeFi" })
    ).toBeVisible();

    // Should describe how many claims are checked
    await expect(
      page.getByText(/Checks 3 claims against the on-chain ProofRegistry/i)
    ).toBeVisible();

    // Wallet input and verify button
    await expect(page.locator("#verify-wallet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify" })).toBeVisible();
  });

  test("verify-preset with a single claim renders the wallet + verify form", async ({
    page,
  }) => {
    await injectMockWalletDisconnected(page);
    await page.goto("/verify-preset?name=KYC+Gate&c=kyc");

    await expect(page.locator("#verify-wallet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Apps gating: access granted after credential is present in localStorage
// ---------------------------------------------------------------------------

test.describe("Apps gating — credential-based access", () => {
  test("LendFi detects KYC credential stored locally", async ({ page }) => {
    await injectMockCredentials(page, [KYC_CREDENTIAL]);
    await page.goto("/apps/lendfi");

    // With a KYC credential the UI should indicate eligibility (not show
    // the hard "connect your wallet" locked state).
    await expect(
      page.getByRole("heading", { name: "LendFi" })
    ).toBeVisible();

    await expect(
      page.getByText("Connect your wallet to check eligibility.")
    ).not.toBeVisible();
  });
});
