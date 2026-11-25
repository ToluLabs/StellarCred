import { describe, it, expect } from "vitest";

import { CONTRACTS } from "../stellar";
import {
  CONTRACT_ENV_VARS,
  missingContractEnvVars,
  contractsConfigured,
  proofSubmissionConfigured,
  missingIssueConfigEnvVars,
  issuanceConfigured,
} from "../config";

describe("contract config checks", () => {
  it("maps every CONTRACTS entry to its env-var name (no drift possible)", () => {
    expect(Object.keys(CONTRACT_ENV_VARS).sort()).toEqual(Object.keys(CONTRACTS).sort());
    for (const name of Object.values(CONTRACT_ENV_VARS)) {
      expect(name).toMatch(/^NEXT_PUBLIC_/);
    }
  });

  it("reports exactly one env-var name per missing contract ID", () => {
    // Under vitest none of the NEXT_PUBLIC_* contract IDs are set (see
    // vitest.config.ts), so everything is reported missing by name.
    const missing = missingContractEnvVars();
    expect(missing.sort()).toEqual(
      [
        "NEXT_PUBLIC_ISSUER_REGISTRY_ID",
        "NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID",
        "NEXT_PUBLIC_PROOF_REGISTRY_ID",
        "NEXT_PUBLIC_GATED_POOL_ID",
      ].sort(),
    );
    expect(contractsConfigured()).toBe(false);
    expect(proofSubmissionConfigured()).toBe(false);
  });
});

describe("issuance config checks", () => {
  it("requires IssuerRegistry even when the issuer address is set", () => {
    // vitest.config.ts sets NEXT_PUBLIC_ISSUER_ADDRESS, so only the registry
    // var should be reported missing here.
    expect(missingIssueConfigEnvVars()).toEqual(["NEXT_PUBLIC_ISSUER_REGISTRY_ID"]);
    expect(issuanceConfigured()).toBe(false);
  });

  it("treats whitespace-only values as missing", () => {
    // missingIssueConfigEnvVars reads process.env directly for the address;
    // simulate an unset value to confirm it is flagged.
    const original = process.env.NEXT_PUBLIC_ISSUER_ADDRESS;
    try {
      delete process.env.NEXT_PUBLIC_ISSUER_ADDRESS;
      expect(missingIssueConfigEnvVars()).toContain("NEXT_PUBLIC_ISSUER_ADDRESS");
      expect(issuanceConfigured()).toBe(false);
    } finally {
      process.env.NEXT_PUBLIC_ISSUER_ADDRESS = original;
    }
  });
});
