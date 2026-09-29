import { describe, expect, it } from "vitest";
import { checkClaimStatus, getClaims, hasClaim, hasClaims } from "./claims";

const dryRun = {
  enabled: true,
  nowSeconds: 1_800_000_000,
  claims: [
    {
      wallet: "demo-wallet",
      claimType: "kyc",
      state: "verified",
      issuer: "issuer-a",
    },
    {
      wallet: "demo-wallet",
      claimType: "funds",
      state: "verified",
      issuer: "issuer-a",
      threshold: 1_000,
    },
    {
      wallet: "demo-wallet",
      claimType: "age",
      state: "expired",
    },
    {
      wallet: "demo-wallet",
      claimType: "income",
      state: "rpc_failure",
      error: "simulated RPC outage",
    },
  ],
} as const;

describe("dry-run claim fixtures", () => {
  it("allows integrators to test gates without a real Stellar address", async () => {
    await expect(hasClaim("demo-wallet", "kyc", { dryRun })).resolves.toBe(true);
    await expect(hasClaim("demo-wallet", "age", { dryRun })).resolves.toBe(false);
  });

  it("supports granular failure states and trusted issuer checks", async () => {
    const status = await checkClaimStatus("demo-wallet", "kyc", {
      dryRun,
      trustedIssuers: ["issuer-b"],
    });

    expect(status.valid).toBe(false);
    expect(status.status).toBe("untrusted_issuer");
  });

  it("evaluates thresholds in batch checks", async () => {
    const result = await hasClaims("demo-wallet", ["kyc", "funds"], {
      dryRun,
      minThresholds: { funds: 5_000 },
    });

    expect(result).toEqual({ kyc: true, funds: false });
  });

  it("throws an RpcError for simulated RPC failures when requested", async () => {
    await expect(
      hasClaim("demo-wallet", "income", { dryRun, throwOnError: true }),
    ).rejects.toMatchObject({ name: "RpcError" });
  });

  it("lists only active verified dry-run claims", async () => {
    const claims = await getClaims("demo-wallet", { dryRun });

    expect(claims).toEqual([
      { type: "kyc", verifiedAt: 1_800_000_000, expiry: 1_800_086_400 },
      { type: "funds", verifiedAt: 1_800_000_000, expiry: 1_800_086_400 },
    ]);
  });
});
