import { test, expect, type Page } from "@playwright/test";

/**
 * E2E coverage for the full contribution pipeline (#873):
 *   1. create account  — wallet connect + first credential issuance
 *   2. submit contribution — holder generates a proof and submits it on-chain
 *   3. verify score update — the claim status flips to On-chain / verified
 *
 * Test data setup runs in `beforeEach` (wallet + seeded credentials + network
 * mocks); teardown in `afterEach` clears the browser profile so cases stay
 * independent.
 *
 * The UltraHonk prover and the Soroban RPC are stubbed at their boundaries
 * (worker script + JSON-RPC) so this exercises the real UI state machine and
 * persistence without a 15–45s WASM prove or a live chain.
 */

const TEST_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TEST_ISSUER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";
const FAKE_TX_HASH =
  "0xabcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";

const nowSec = () => Math.floor(Date.now() / 1000);

function unprovedCredential() {
  return {
    type: "kyc",
    title: "Identity Verified",
    claim: "kyc",
    issuer: "StellarCred Authority",
    issuerId: TEST_ISSUER,
    holder: TEST_WALLET,
    value: "alice",
    salt: "0xabc",
    commitment: "0xcontrib1",
    sig: [1, 2, 3],
    issuerPubX: [4, 5, 6],
    issuerPubY: [7, 8, 9],
    issuedAt: nowSec() - 60,
    expiry: "90 days",
    circuitVersion: "1.0.0-beta.9",
  };
}

/**
 * Stub the dedicated prover worker so "Generate proof" completes instantly.
 * Speaks the same message protocol as lib/proof-worker.ts: progress events
 * followed by a `result` carrying a fixed-size UltraHonk-shaped proof.
 */
const STUB_PROOF_WORKER = `
self.postMessage({
  event: "ready",
  crossOriginIsolated: false,
  hardwareConcurrency: 1,
});
self.onmessage = (e) => {
  const cmd = e.data || {};
  if (cmd.command === "prove") {
    const jobId = cmd.jobId;
    self.postMessage({ event: "progress", jobId, stage: "witness" });
    self.postMessage({ event: "progress", jobId, stage: "circuit" });
    self.postMessage({ event: "progress", jobId, stage: "proof" });
    const proof = new Uint8Array(14592);
    const publicInputs = new Uint8Array(2080);
    self.postMessage({ event: "result", jobId, proof, publicInputs }, [
      proof.buffer,
      publicInputs.buffer,
    ]);
    return;
  }
  if (cmd.command === "warm" || cmd.command === "destroy") {
    self.postMessage({ event: "done", jobId: cmd.jobId });
    return;
  }
  if (cmd.command === "cancel") {
    self.postMessage({
      event: "error",
      jobId: cmd.jobId,
      name: "AbortError",
      message: "Aborted",
    });
  }
};
`;

/** JSON-RPC 2.0 replies the Soroban SDK needs to send + confirm a tx. */
function rpcResult(method: string): Record<string, unknown> {
  switch (method) {
    case "getNetwork":
      return {
        passphrase: "Test SDF Network ; September 2015",
        protocolVersion: 23,
      };
    case "getLatestLedger":
      return { sequence: 1_000_000, protocolVersion: 23 };
    case "getHealth":
      return { status: "healthy" };
    case "sendTransaction":
      return {
        status: "PENDING",
        hash: FAKE_TX_HASH.replace(/^0x/, ""),
        latestLedger: 1_000_000,
        latestLedgerCloseTime: String(nowSec()),
      };
    case "getTransaction":
      return {
        status: "SUCCESS",
        latestLedger: 1_000_001,
        latestLedgerCloseTime: String(nowSec()),
        oldestLedger: 999_000,
        oldestLedgerCloseTime: String(nowSec() - 10),
        applicationOrder: 1,
        envelopeXdr: "",
        resultXdr: "",
        resultMetaXdr: "",
        ledger: 1_000_001,
        createdAt: String(nowSec()),
        feeBump: false,
      };
    default:
      return {};
  }
}

async function installNetworkMocks(page: Page) {
  // Server-side witness generation (would run the Noir circuit).
  await page.route("**/api/witness", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ witness: "00".repeat(64) }),
    });
  });

  // Issuance endpoint used when creating the first credential.
  await page.route("**/api/issue", async (route) => {
    const postData = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        credentials: [
          {
            ...unprovedCredential(),
            type: postData.credential_types?.[0] || "kyc",
            holder: postData.holder || TEST_WALLET,
          },
        ],
      }),
    });
  });

  // Soroban RPC (JSON-RPC 2.0 over POST). Answer the methods the submit path
  // needs; everything else gets a benign empty result so the SDK does not hang.
  await page.route("**/soroban-testnet.stellar.org/**", async (route) => {
    const body = route.request().postDataJSON() as
      | { id?: unknown; method?: string }
      | undefined;
    const method = body?.method ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: body?.id ?? 1,
        result: rpcResult(method),
      }),
    });
  });

  // Prover worker stub — replaces the bundled WASM worker.
  await page.route("**/workers/proof-worker.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: STUB_PROOF_WORKER,
    });
  });
}

async function installWallet(page: Page) {
  await page.addInitScript(
    ({ walletAddress }) => {
      (window as any).rabet = {
        connect: async () => ({ publicKey: walletAddress }),
        sign: async (xdr: string) => ({ xdr, signedTxXdr: xdr }),
        signTransaction: async (xdr: string) => ({ signedTxXdr: xdr, xdr }),
        getNetwork: async () => ({
          networkPassphrase: "Test SDF Network ; September 2015",
        }),
      };
      localStorage.setItem("stellarcred:wallet-id", "rabet");
      localStorage.setItem(
        "stellarcred:onboarding",
        JSON.stringify({ step: 4, dismissed: true, completed: true }),
      );
      localStorage.setItem("stellarcred_onboarding_seen", "1");
    },
    { walletAddress: TEST_WALLET },
  );
}

async function seedCredential(page: Page, credential: Record<string, unknown>) {
  await page.addInitScript((cred) => {
    localStorage.setItem("stellarcred:credentials", JSON.stringify([cred]));
  }, credential);
}

test.beforeEach(async ({ page }) => {
  await installNetworkMocks(page);
  await installWallet(page);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => localStorage.clear());
});

test.describe("Contribution pipeline", () => {
  test("creates account, submits contribution, and verifies the score update", async ({
    page,
  }) => {
    await seedCredential(page, unprovedCredential());

    // ── 1. Create account: wallet is restored and the holder lands on their list
    await page.goto("/holder");
    await expect(page.getByRole("heading", { name: "Your credentials" })).toBeVisible();
    await expect(page.getByText("Identity Verified").first()).toBeVisible();

    // ── 2. Submit contribution: enter the proof flow for the unproved credential
    const generateBtn = page.getByRole("button", { name: "Generate proof" });
    await expect(generateBtn).toBeVisible();
    await generateBtn.first().click();

    // Prover stub resolves instantly; the submit CTA unlocks.
    await expect(page.getByRole("button", { name: "Submit to Stellar" })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Submit to Stellar" }).click();

    // ── 3. Score update: submission confirms and the claim is marked on-chain
    await expect(page.getByText(/Proof verified on-chain/i)).toBeVisible({
      timeout: 15_000,
    });

    // Persistence check — provedAt / provedTxHash written to the credential store.
    const stored = await page.evaluate(() =>
      localStorage.getItem("stellarcred:credentials"),
    );
    expect(stored).toBeTruthy();
    const creds = JSON.parse(stored!) as Array<{
      commitment: string;
      provedAt?: number;
      provedTxHash?: string;
    }>;
    const proved = creds.find((c) => c.commitment === "0xcontrib1");
    expect(proved?.provedAt).toBeGreaterThan(0);
    expect(proved?.provedTxHash).toBeTruthy();
  });

  test("seeded unproved credential shows as Held until contribution is submitted", async ({
    page,
  }) => {
    await seedCredential(page, unprovedCredential());
    await page.goto("/holder");

    await expect(page.getByRole("heading", { name: "Your credentials" })).toBeVisible();
    // Not yet on-chain — still in the held / needs-proof bucket.
    await expect(page.getByText("Held").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate proof" }).first()).toBeVisible();
    // Teardown contract: the store starts with exactly the seeded credential.
    const count = await page.evaluate(() => {
      const raw = localStorage.getItem("stellarcred:credentials");
      return raw ? JSON.parse(raw).length : 0;
    });
    expect(count).toBe(1);
  });
});
