import { defineConfig, devices } from "@playwright/test";

const port = process.env.PORT ?? "3100";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `pnpm exec next start -p ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
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
        },
      },
});
