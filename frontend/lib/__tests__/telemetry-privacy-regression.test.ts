import { describe, it, expect, vi } from "vitest";
import { stripSensitiveFields, SAFE_FIELDS } from "../logger";
import { summarizeProofs } from "../telemetry-reporter";
import type { ProofRun } from "../proof-perf";

describe("telemetry-privacy-regression (#975)", () => {
  const sensitiveCredentialPayload = {
    event: "proof_generated",
    credentialType: "kyc",
    issuerId: "GBBB111",
    durationMs: 1200,
    requestId: "req-12345",
    // Sensitive fields that MUST be stripped:
    value: "secret_ssn_or_nin_value_12345",
    salt: "secret_blinding_salt_9876543210",
    sig: [1, 2, 3, 4, 5],
    issuerPrivateKey: "ed25519_secret_key_bytes",
    passphrase: "super_secret_user_passphrase",
    credentialJson: '{"private":"everything"}',
  };

  it("stripSensitiveFields strips all sensitive credential data and keeps only SAFE_FIELDS", () => {
    const stripped = stripSensitiveFields(sensitiveCredentialPayload);

    // Permitted safe telemetry fields should be preserved
    expect(stripped.event).toBe("proof_generated");
    expect(stripped.credentialType).toBe("kyc");
    expect(stripped.issuerId).toBe("GBBB111");
    expect(stripped.durationMs).toBe(1200);
    expect(stripped.requestId).toBe("req-12345");

    // Sensitive values must not exist on the returned object
    expect((stripped as Record<string, unknown>).value).toBeUndefined();
    expect((stripped as Record<string, unknown>).salt).toBeUndefined();
    expect((stripped as Record<string, unknown>).sig).toBeUndefined();
    expect((stripped as Record<string, unknown>).issuerPrivateKey).toBeUndefined();
    expect((stripped as Record<string, unknown>).passphrase).toBeUndefined();
    expect((stripped as Record<string, unknown>).credentialJson).toBeUndefined();
  });

  it("SAFE_FIELDS allowlist explicitly excludes private attributes", () => {
    expect(SAFE_FIELDS).not.toContain("value");
    expect(SAFE_FIELDS).not.toContain("salt");
    expect(SAFE_FIELDS).not.toContain("sig");
    expect(SAFE_FIELDS).not.toContain("privateKey");
    expect(SAFE_FIELDS).not.toContain("passphrase");
    expect(SAFE_FIELDS).not.toContain("token");
  });

  it("summarizeProofs aggregates duration numbers only and contains zero credential secrets", () => {
    const mockRuns: ProofRun[] = [
      {
        id: "run-1",
        status: "ok",
        credentialType: "kyc",
        startedAt: 1_700_000_000_000,
        stages: [
          { stage: "witness", durationMs: 200, budgetMs: 20_000, overBudget: false },
          { stage: "prove", durationMs: 800, budgetMs: 60_000, overBudget: false },
          { stage: "submit", durationMs: 400, budgetMs: 15_000, overBudget: false },
        ],
        timeToFirstProofMs: 1400,
        totalMs: 1800,
        exceededBudget: false,
        deviceClass: "desktop",
        cores: 8,
        memoryGB: 16,
        warm: false,
      },
    ];

    const summary = summarizeProofs(mockRuns);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("salt");
    expect(serialized).not.toContain("sig");
    expect(summary.totalRuns).toBe(1);
    expect(summary.byStage.length).toBe(3);
  });

  it("logs do not print sensitive values during console execution", () => {
    const consoleSpy = vi.spyOn(console, "log");

    // Process sanitized telemetry
    const sanitized = stripSensitiveFields(sensitiveCredentialPayload);
    console.log(JSON.stringify(sanitized));

    const logged = consoleSpy.mock.calls[0][0];
    expect(logged).not.toContain("secret_ssn_or_nin_value_12345");
    expect(logged).not.toContain("secret_blinding_salt_9876543210");
    expect(logged).not.toContain("super_secret_user_passphrase");
    consoleSpy.mockRestore();
  });
});
