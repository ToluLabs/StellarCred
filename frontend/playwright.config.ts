import { defineConfig, devices } from "@playwright/test";

const port = process.env.PORT ?? "3100";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;

/**
 * Shared stub env-vars fed to the Next.js dev/start server during E2E runs.
 * These are dummy Soroban contract IDs — the E2E tests mock all network calls
 * so the real contracts are never contacted during CI.
 */
const stubEnv: Record<string, string> = {
  PORT: port,
  NEXT_PUBLIC_PROOF_REGISTRY_ID:
    process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID ||
    "C000000000000000000000000000000000000000000000000000000000000001",
  NEXT_PUBLIC_ISSUER_REGISTRY_ID:
    process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID ||
    "C000000000000000000000000000000000000000000000000000000000000002",
  NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID:
    process.env.NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID ||
    "C000000000000000000000000000000000000000000000000000000000000003",
  NEXT_PUBLIC_GATED_POOL_ID:
    process.env.NEXT_PUBLIC_GATED_POOL_ID ||
    "C000000000000000000000000000000000000000000000000000000000000004",
  NEXT_PUBLIC_ISSUER_ADDRESS:
    process.env.NEXT_PUBLIC_ISSUER_ADDRESS ||
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  NEXT_PUBLIC_STELLAR_NETWORK:
    process.env.NEXT_PUBLIC_STELLAR_NETWORK || "testnet",
  NEXT_PUBLIC_RPC_URL:
    process.env.NEXT_PUBLIC_RPC_URL ||
    "https://soroban-testnet.stellar.org",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Retry once in CI to tolerate transient timing flakiness; no retries locally.
  retries: process.env.CI ? 1 : 0,
  // Use the GitHub-native reporter in CI (folds into PR annotations).
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    // Capture a screenshot on test failure so the artifact contains useful
    // context even when trace upload is disabled.
    screenshot: "only-on-failure",
  },
  projects: [
    // ── Desktop browsers ────────────────────────────────────────────────────
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    // ── Mobile viewports ────────────────────────────────────────────────────
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "mobile-safari",
      use: { ...devices["iPhone 12"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `pnpm exec next start -p ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: stubEnv,
      },
});
