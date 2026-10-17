/**
 * Mock wallet injection helpers for Playwright E2E tests.
 *
 * These helpers inject a deterministic in-page mock for the Stellar Wallets
 * Kit (Rabet / Freighter API surface) so tests never require a real browser
 * extension and never hit the real Stellar network.
 *
 * Usage:
 *   await injectMockWallet(page, TEST_WALLET);        // connect wallet
 *   await injectMockWalletDisconnected(page);         // no wallet state
 *   await injectMockCredentials(page, credentials);  // seed localStorage
 */

import type { Page } from "@playwright/test";
import { SEEDED_CREDENTIALS } from "./fixtures";

/** Deterministic test wallet address (valid Stellar public key format). */
export const TEST_WALLET =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Secondary wallet address used in multi-wallet tests. */
export const TEST_WALLET_2 =
  "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF";

/** Fake issuer address used in all mock credentials. */
export const TEST_ISSUER =
  "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

/**
 * Injects a mock Rabet wallet that reports `address` as connected, suppresses
 * the onboarding wizard, and clears any prior wallet state from localStorage.
 */
export async function injectMockWallet(
  page: Page,
  address: string = TEST_WALLET
): Promise<void> {
  await page.addInitScript(
    ({ walletAddress }) => {
      // Dismiss onboarding so tests don't have to interact with it.
      localStorage.setItem(
        "stellarcred:onboarding",
        JSON.stringify({ step: 4, dismissed: true, completed: true })
      );
      localStorage.setItem("stellarcred_onboarding_seen", "1");

      // Inject a minimal Rabet-compatible API that resolves synchronously.
      (window as any).rabet = {
        connect: async () => ({ publicKey: walletAddress }),
        sign: async (xdr: string, _network: string) => ({ xdr }),
        disconnect: async () => {},
      };

      // Pre-set the persisted wallet ID so the wallet-context restore path
      // picks up the mock address without requiring an explicit connect click.
      localStorage.setItem("stellarcred:wallet-id", "rabet");
    },
    { walletAddress: address }
  );
}

/**
 * Injects the onboarding-dismissed state only — no wallet is connected.
 * Use this when the test needs to exercise the "connect wallet" prompt.
 */
export async function injectMockWalletDisconnected(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      "stellarcred:onboarding",
      JSON.stringify({ step: 4, dismissed: true, completed: true })
    );
    localStorage.setItem("stellarcred_onboarding_seen", "1");

    // Inject the wallet API but do NOT persist the wallet-id, so the context
    // starts in the disconnected state and requires a click to connect.
    (window as any).rabet = {
      connect: async () => ({ publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }),
      sign: async (xdr: string, _network: string) => ({ xdr }),
      disconnect: async () => {},
    };
  });
}

/**
 * Seed localStorage with the provided credentials before the page loads.
 * Must be called before `page.goto()`.
 */
export async function injectMockCredentials(
  page: Page,
  credentials: unknown[] = SEEDED_CREDENTIALS,
  address: string = TEST_WALLET
): Promise<void> {
  await injectMockWallet(page, address);
  await page.addInitScript(
    ({ creds }) => {
      localStorage.setItem("stellarcred:credentials", JSON.stringify(creds));
    },
    { creds: credentials }
  );
}

/**
 * Mock the /api/issue endpoint.  The stub echoes back one credential of the
 * first requested type so the verify flow progresses without a real issuer.
 */
export async function mockIssueApi(
  page: Page,
  issuerAddress: string = TEST_ISSUER
): Promise<void> {
  await page.route("**/api/issue", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const type: string = body.credential_types?.[0] ?? "age";
    const holder: string = body.holder ?? TEST_WALLET;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        credentials: [
          {
            type,
            title: type === "age" ? "Age Verified" : type.charAt(0).toUpperCase() + type.slice(1),
            claim: type === "age" ? "age ≥ 18" : `${type} verified`,
            issuer: "StellarCred Authority",
            issuerId: issuerAddress,
            holder,
            value: type === "age" ? "1995-06-15" : "42",
            salt: "0x1234",
            commitment: "0x5678",
            sig: Array(64).fill(1),
            issuerPubX: Array(32).fill(2),
            issuerPubY: Array(32).fill(3),
            issuedAt: Math.floor(Date.now() / 1000),
            expiry: "90 days",
          },
        ],
      }),
    });
  });
}
