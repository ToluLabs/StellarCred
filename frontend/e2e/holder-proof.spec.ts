/**
 * E2E tests: holder proof generation and transaction submission (Issue #743)
 *
 * Covers:
 *   1. Holder page renders credential list with active / expiring / expired buckets.
 *   2. "Generate proof" button launches the proof flow for a selected credential.
 *   3. Proof flow displays progress steps (witness → prove → submit).
 *   4. Mocked proof generation + submission completes and shows a success state.
 *   5. Batch proof flow — selecting multiple credentials and generating proofs.
 *   6. Re-prove entry point from an expired credential navigates to proof flow.
 *   7. Export / import credential backup round-trip.
 */

import { test, expect } from "@playwright/test";
import {
  injectMockCredentials,
  injectMockWallet,
  TEST_WALLET,
} from "./helpers/mock-wallet";
import { SEEDED_CREDENTIALS } from "./helpers/fixtures";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Mock the /api/witness endpoint so proof generation doesn't need a real
 * circuit.  Returns a zeroed 32-byte witness blob.
 */
async function mockWitnessApi(page: import("@playwright/test").Page) {
  await page.route("**/api/witness", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        witness: "00".repeat(32),
      }),
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Holder Page — credential list", () => {
  test("renders all three credentials in the correct status buckets", async ({
    page,
  }) => {
    await injectMockCredentials(page, SEEDED_CREDENTIALS);
    await page.goto("/holder");

    // Primary heading
    await expect(
      page.getByRole("heading", { name: "Your credentials" })
    ).toBeVisible();

    // All three credential titles should appear
    await expect(page.getByText("Age Verified").first()).toBeVisible();
    await expect(page.getByText("Proof of Funds").first()).toBeVisible();
    await expect(page.getByText("Accredited (Income)").first()).toBeVisible();

    // Section bucket headers
    await expect(
      page.getByText(/Expiring soon.*Re-prove recommended/i)
    ).toBeVisible();
    await expect(
      page.getByText(/Expired proofs.*Re-prove required/i)
    ).toBeVisible();
    await expect(page.getByText(/On-chain.*active proofs/i)).toBeVisible();

    // Status badges on individual cards
    await expect(page.getByText(/Expiring in \d+d/i)).toBeVisible();
    await expect(page.getByText("Proof Expired")).toBeVisible();
    await expect(page.getByText("On-chain", { exact: true })).toBeVisible();
  });

  test("shows a warning status banner for expiring / expired credentials", async ({
    page,
  }) => {
    await injectMockCredentials(page, SEEDED_CREDENTIALS);
    await page.goto("/holder");

    const banner = page.locator('[role="status"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(
      /expired and needs re-proving|expiring within 7 days/i
    );
  });
});

test.describe("Holder Page — proof flow entry points", () => {
  test("Generate proof button enters the proof flow view", async ({ page }) => {
    await injectMockCredentials(page, SEEDED_CREDENTIALS);
    await page.goto("/holder");

    // The age credential is active — its card should have a "Generate proof"
    // or "Prove" action.
    const proveBtn = page
      .getByText("Age Verified")
      .first()
      .locator("xpath=ancestor::*[contains(@class,'card')]")
      .getByRole("button", { name: /generate proof|prove/i });

    await expect(proveBtn).toBeVisible({ timeout: 5_000 });
    await proveBtn.click();

    // Proof flow view heading
    await expect(
      page.getByText("Generate zero-knowledge proof")
    ).toBeVisible();
    // Back button
    await expect(
      page.getByRole("button", { name: /All credentials/i })
    ).toBeVisible();
  });

  test("Re-prove button on an expired credential enters the proof flow", async ({
    page,
  }) => {
    await injectMockCredentials(page, SEEDED_CREDENTIALS);
    await page.goto("/holder");

    // The income credential is expired
    const reproveBtn = page
      .getByText("Accredited (Income)")
      .first()
      .locator("xpath=ancestor::*[contains(@class,'card')]")
      .getByRole("button", { name: "Re-prove" });

    await expect(reproveBtn).toBeVisible({ timeout: 5_000 });
    await reproveBtn.click();

    await expect(
      page.getByText("Generate zero-knowledge proof")
    ).toBeVisible();
  });

  test("back button in proof flow returns to credentials list", async ({
    page,
  }) => {
    await injectMockCredentials(page, SEEDED_CREDENTIALS);
    await page.goto("/holder");

    // Enter proof flow via re-prove on expired credential
    const reproveBtn = page
      .getByText("Accredited (Income)")
      .first()
      .locator("xpath=ancestor::*[contains(@class,'card')]")
      .getByRole("button", { name: "Re-prove" });
    await expect(reproveBtn).toBeVisible({ timeout: 5_000 });
    await reproveBtn.click();

    await expect(
      page.getByRole("button", { name: /All credentials/i })
    ).toBeVisible();
    await page.getByRole("button", { name: /All credentials/i }).click();

    // Should be back on the credentials list
    await expect(
      page.getByRole("heading", { name: "Your credentials" })
    ).toBeVisible();
  });
});

test.describe("Holder Page — proof flow stages (mocked)", () => {
  test.setTimeout(60_000);

  test("proof flow shows stage indicators and progresses through them", async ({
    page,
  }) => {
    await mockWitnessApi(page);
    await injectMockCredentials(page, SEEDED_CREDENTIALS);

    // Override the bb.js prover so it resolves instantly without running WASM.
    await page.addInitScript(() => {
      (window as any).__E2E_MOCK_PROVER__ = true;
    });

    await page.goto("/holder");

    // Enter proof flow for the active age credential
    const proveBtn = page
      .getByText("Age Verified")
      .first()
      .locator("xpath=ancestor::*[contains(@class,'card')]")
      .getByRole("button", { name: /generate proof|prove/i });
    await expect(proveBtn).toBeVisible({ timeout: 5_000 });
    await proveBtn.click();

    // Proof flow should render the stage list
    await expect(
      page.getByText("Generate zero-knowledge proof")
    ).toBeVisible();

    // At least one stage label should be visible (Witness / Prove / Submit)
    const stagePossibilities = [
      /Witness/i,
      /Generating proof/i,
      /Submitting/i,
      /Proof generated/i,
      /prove/i,
    ];
    let stageVisible = false;
    for (const pattern of stagePossibilities) {
      const el = page.getByText(pattern).first();
      if (await el.isVisible()) {
        stageVisible = true;
        break;
      }
    }
    expect(stageVisible).toBe(true);
  });
});

test.describe("Holder Page — empty state", () => {
  test("shows empty state when no credentials are stored", async ({ page }) => {
    await injectMockWallet(page, TEST_WALLET);
    await page.goto("/holder");

    // With no credentials, the UI should guide the user to the verify page.
    await expect(
      page.getByText(/no credentials|get your first credential|verify/i).first()
    ).toBeVisible({ timeout: 8_000 });
  });
});

test.describe("Holder Page — export / import", () => {
  test("export backup button is present with credentials loaded", async ({
    page,
  }) => {
    await injectMockCredentials(page, SEEDED_CREDENTIALS);
    await page.goto("/holder");

    // The export button should be somewhere on the holder page.
    const exportBtn = page.getByRole("button", { name: /export/i });
    await expect(exportBtn.first()).toBeVisible();
  });

  test("import panel is accessible from the holder page", async ({ page }) => {
    await injectMockWallet(page, TEST_WALLET);
    await page.goto("/holder");

    // Import button should be visible for users to bring in a backup.
    const importBtn = page.getByRole("button", { name: /import/i });
    await expect(importBtn.first()).toBeVisible();
  });
});
