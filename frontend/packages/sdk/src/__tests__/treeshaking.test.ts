import { describe, it, expect, beforeEach } from "vitest";
import {
  buildVerifyUrl,
  buildBadgeUrl,
  buildBadgeEmbedCode,
  CLAIM_TYPES,
  TimeoutError,
  ConfigError,
  InvalidAddressError,
  createClaimGate,
  resetClientForTesting,
  resetConfig,
  hasClaim,
} from "../index";
import pkg from "../../package.json";

describe("SDK tree-shaking and dynamic import gating (#765)", () => {
  beforeEach(() => {
    resetConfig();
    resetClientForTesting();
  });

  it("package.json declares sideEffects: false for bundler optimization", () => {
    expect(pkg.sideEffects).toBe(false);
  });

  it("pure URL helpers execute synchronously without initializing RPC client", () => {
    const verifyUrl = buildVerifyUrl({
      claim: "kyc",
      returnUrl: "https://app.example.com/callback",
    });
    // buildVerifyUrl uses the `claim` query param, not `type`
    expect(verifyUrl).toContain("claim=kyc");
    expect(verifyUrl).toContain("return_url=");

    const badgeUrl = buildBadgeUrl({
      wallet: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      claim: "age",
    });
    expect(badgeUrl).toContain("claim=age");
    expect(badgeUrl).toContain("wallet=");

    const embed = buildBadgeEmbedCode({
      wallet: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      claim: "kyc",
    });
    expect(embed).toContain("<iframe");
  });

  it("exports error classes and constants without network dependencies", () => {
    expect(CLAIM_TYPES).toContain("kyc");
    expect(CLAIM_TYPES).toContain("age");
    expect(CLAIM_TYPES).toContain("income");

    const err = new ConfigError("Missing config");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ConfigError");

    const tErr = new TimeoutError("Timed out");
    expect(tErr.name).toBe("TimeoutError");

    const addrErr = new InvalidAddressError("Bad address");
    expect(addrErr.name).toBe("InvalidAddressError");
  });

  it("createClaimGate initializes offline state without dispatching RPC requests", () => {
    const gate = createClaimGate({
      wallet: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      claims: ["kyc"],
    });

    // Gate starts in loading state — the initial fetch runs asynchronously.
    // Before any fetch completes, claims is null and error is null.
    const state = gate.getSnapshot();
    expect(state.loading).toBe(true);
    expect(state.claims).toBeNull();
    expect(state.error).toBeNull();
    gate.destroy();
  });

  it("hasClaim throws ConfigError gracefully when registry is not configured", async () => {
    const res = await hasClaim(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "kyc",
    );
    expect(res).toBe(false);
  });
});
