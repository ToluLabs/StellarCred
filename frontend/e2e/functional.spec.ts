import { test, expect } from "@playwright/test";

const TEST_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TEST_ISSUER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

const nowSec = Math.floor(Date.now() / 1000);
const daySec = 86400;

function createMockCredentials() {
  return [
    {
      type: "age",
      title: "Age Verified",
      claim: "age ≥ 18",
      issuer: "StellarCred Authority",
      issuerId: TEST_ISSUER,
      holder: TEST_WALLET,
      value: "1995-06-15",
      salt: "0x111",
      commitment: "0x222",
      sig: [1, 2, 3],
      issuerPubX: [4, 5, 6],
      issuerPubY: [7, 8, 9],
      issuedAt: nowSec - 5 * daySec,
      expiry: "90 days",
      provedAt: nowSec - 5 * daySec,
      provedTxHash:
        "0xabcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
    },
    {
      type: "funds",
      title: "Proof of Funds",
      claim: "balance > $10,000",
      issuer: "StellarCred Authority",
      issuerId: TEST_ISSUER,
      holder: TEST_WALLET,
      value: "50000",
      salt: "0x333",
      commitment: "0x444",
      sig: [1, 2, 3],
      issuerPubX: [4, 5, 6],
      issuerPubY: [7, 8, 9],
      issuedAt: nowSec - 85 * daySec,
      expiry: "90 days",
      provedAt: nowSec - 85 * daySec,
      provedTxHash:
        "0xbeef1234beef1234beef1234beef1234beef1234beef1234beef1234beef1234",
    },
    {
      type: "income",
      title: "Accredited (Income)",
      claim: "income > $200,000",
      issuer: "StellarCred Authority",
      issuerId: TEST_ISSUER,
      holder: TEST_WALLET,
      value: "250000",
      salt: "0x555",
      commitment: "0x666",
      sig: [1, 2, 3],
      issuerPubX: [4, 5, 6],
      issuerPubY: [7, 8, 9],
      issuedAt: nowSec - 10 * daySec,
      expiry: "30 days",
      provedAt: nowSec - 35 * daySec,
      provedTxHash:
        "0xdead1234dead1234dead1234dead1234dead1234dead1234dead1234dead1234",
    },
  ];
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "stellarcred:onboarding",
      JSON.stringify({ step: 4, dismissed: true, completed: true })
    );
    localStorage.setItem("stellarcred_onboarding_seen", "1");
  });
});

test.describe("Verify Flow", () => {
  test("lands on /verify with params, issues credential in mock mode, and redirects with verification flags", async ({
    page,
  }) => {
    // Inject mock Rabet wallet connected to TEST_WALLET
    await page.addInitScript(
      ({ walletAddress }) => {
        (window as any).rabet = {
          connect: async () => ({ publicKey: walletAddress }),
          sign: async (xdr: string) => ({ xdr }),
        };
        localStorage.setItem("stellarcred:wallet-id", "rabet");
      },
      { walletAddress: TEST_WALLET }
    );

    // Mock issuance endpoint
    await page.route("**/api/issue", async (route) => {
      const postData = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          credentials: [
            {
              type: postData.credential_types?.[0] || "age",
              title: "Age Verified",
              claim: "age ≥ 18",
              issuer: "StellarCred Authority",
              issuerId: TEST_ISSUER,
              holder: postData.holder || TEST_WALLET,
              value: "1995-06-15",
              salt: "0x123",
              commitment: "0x456",
              sig: [1, 2, 3],
              issuerPubX: [4, 5, 6],
              issuerPubY: [7, 8, 9],
              issuedAt: Math.floor(Date.now() / 1000),
              expiry: "90 days",
            },
          ],
        }),
      });
    });

    // Navigate to /verify with locked claim and return_url
    await page.goto("/verify?claim=age&return_url=/apps/lendfi");

    await expect(page.getByRole("heading", { name: "Get verified" })).toBeVisible();
    await expect(page.getByText("A protocol requested the age credential")).toBeVisible();

    const getCredBtn = page.getByRole("button", { name: /get credential/i });
    await expect(getCredBtn).toBeVisible();
    await getCredBtn.click();

    // Expect redirect to /apps/lendfi carrying sc_verified and sc_claims
    await expect(page).toHaveURL(/\/apps\/lendfi\?.*sc_verified=true/, {
      timeout: 10_000,
    });

    const currentUrl = new URL(page.url());
    expect(currentUrl.pathname).toBe("/apps/lendfi");
    expect(currentUrl.searchParams.get("sc_verified")).toBe("true");
    expect(currentUrl.searchParams.get("sc_claims")).toBe("age");
    expect(currentUrl.searchParams.get("sc_wallet")).toBe(TEST_WALLET);
  });
});

test.describe("Holder Page", () => {
  test("renders credential list, expiring/expired states, and re-prove entry point", async ({
    page,
  }) => {
    // Inject mock Rabet wallet and seed credentials
    await page.addInitScript(
      ({ walletAddress, credentials }) => {
        (window as any).rabet = {
          connect: async () => ({ publicKey: walletAddress }),
          sign: async (xdr: string) => ({ xdr }),
        };
        localStorage.setItem("stellarcred:wallet-id", "rabet");
        localStorage.setItem("stellarcred:credentials", JSON.stringify(credentials));
      },
      { walletAddress: TEST_WALLET, credentials: createMockCredentials() }
    );

    await page.goto("/holder");

    // 1. Verify credential list renders
    await expect(page.getByRole("heading", { name: "Your credentials" })).toBeVisible();
    await expect(page.getByText("Age Verified").first()).toBeVisible();
    await expect(page.getByText("Proof of Funds").first()).toBeVisible();
    await expect(page.getByText("Accredited (Income)").first()).toBeVisible();

    // 2. Verify expiring / expired states show
    // Warning banner is rendered
    const statusBanner = page.locator('[role="status"]');
    await expect(statusBanner).toBeVisible();
    await expect(statusBanner).toContainText(
      /expired and needs re-proving|expiring within 7 days/i
    );

    // Section headers
    await expect(page.getByText(/Expiring soon · Re-prove recommended/i)).toBeVisible();
    await expect(page.getByText(/Expired proofs · Re-prove required/i)).toBeVisible();
    await expect(page.getByText(/On-chain · active proofs/i)).toBeVisible();

    // Badges on cards
    await expect(page.getByText(/Expiring in \d+d/i)).toBeVisible();
    await expect(page.getByText("Proof Expired")).toBeVisible();
    await expect(page.getByText("On-chain", { exact: true })).toBeVisible();

    // 3. Test re-prove entry point
    const reproveButtons = page.getByRole("button", { name: "Re-prove" });
    await expect(reproveButtons.first()).toBeVisible();
    await reproveButtons.first().click();

    // Verify it entered the proving flow view
    await expect(page.getByRole("button", { name: /All credentials/i })).toBeVisible();
    await expect(page.getByText("Generate zero-knowledge proof")).toBeVisible();

    // Back button returns to credentials list
    await page.getByRole("button", { name: /All credentials/i }).click();
    await expect(page.getByRole("heading", { name: "Your credentials" })).toBeVisible();
  });
});

test.describe("Apps Gating", () => {
  test("shows locked state without a claim and unlocked state after verification", async ({
    page,
  }) => {
    // 1. Locked state (no wallet / claim)
    await page.goto("/apps/lendfi");

    await expect(page.getByRole("heading", { name: "LendFi" })).toBeVisible();
    await expect(page.getByText("Connect your wallet to check eligibility.")).toBeVisible();

    // Requirements show "Needed"
    const neededBadges = page.locator(".card").getByText("Needed");
    await expect(neededBadges.first()).toBeVisible();

    // Action button disabled
    const lockedBtn = page.getByRole("button", {
      name: /Connect wallet to check access|Prove eligibility first/i,
    });
    await expect(lockedBtn).toBeVisible();
    await expect(lockedBtn).toBeDisabled();

    // 2. Unlocked state with verification return parameters
    await page.goto(`/apps/lendfi?sc_verified=true&sc_wallet=${TEST_WALLET}`);

    // Verification banner is visible
    await expect(page.getByText(/Verification complete/i)).toBeVisible();
    await expect(
      page.getByText(/You were returned here from StellarCred automatically/i)
    ).toBeVisible();
  });
});

test.describe("Badge and Verify-Preset Pages", () => {
  test("badge renders correctly for valid and invalid parameters", async ({
    page,
  }) => {
    // Invalid params: missing wallet
    await page.goto("/badge");
    await expect(page.locator("a[href='https://stellarcred.xyz']")).toBeVisible();
    await expect(page.getByText("Not verified")).toBeVisible();

    // Valid params with wallet and claim
    await page.goto(`/badge?wallet=${TEST_WALLET}&claim=age`);
    await expect(page.locator("a[href='https://stellarcred.xyz']")).toBeVisible();
    await expect(page.getByText("Age 18+")).toBeVisible();

    // Valid params with custom claim
    await page.goto(`/badge?wallet=${TEST_WALLET}&claim=income`);
    await expect(page.locator("a[href='https://stellarcred.xyz']")).toBeVisible();
    await expect(page.getByText("Income")).toBeVisible();
  });

  test("verify-preset renders correctly for valid and invalid parameters", async ({
    page,
  }) => {
    // Invalid params: no claim query or unrecognized claims
    await page.goto("/verify-preset");
    await expect(
      page.getByText(/This link doesn't name any recognised claims/i)
    ).toBeVisible();

    await page.goto("/verify-preset?c=invalid_claim_type");
    await expect(
      page.getByText(/This link doesn't name any recognised claims/i)
    ).toBeVisible();

    // Valid params: preset with name and valid encoded claims
    await page.goto("/verify-preset?name=Institutional+DeFi&c=kyc,age:21,income:200000");
    await expect(
      page.getByRole("heading", { name: "Institutional DeFi" })
    ).toBeVisible();
    await expect(
      page.getByText(/Checks 3 claims against the on-chain ProofRegistry/i)
    ).toBeVisible();
    await expect(page.locator("#verify-wallet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify" })).toBeVisible();
  });
});
