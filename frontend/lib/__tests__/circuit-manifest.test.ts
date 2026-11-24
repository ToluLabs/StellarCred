import { describe, it, expect } from "vitest";
import {
  SUPPORTED_CIRCUITS_MANIFEST,
  getSupportedCircuits,
  isCircuitSupported,
  isCircuitExperimental,
  getCircuitManifestEntry,
  validateReleaseArtifacts,
} from "../circuit-manifest";

describe("circuit-manifest (#972)", () => {
  it("defines manifest with required v1 release fields", () => {
    expect(SUPPORTED_CIRCUITS_MANIFEST.manifestVersion).toBe("1.0.0");
    expect(SUPPORTED_CIRCUITS_MANIFEST.release).toBe("v1.0.0");
    expect(SUPPORTED_CIRCUITS_MANIFEST.circuits.length).toBeGreaterThan(0);
  });

  it("distinguishes supported from experimental circuits", () => {
    expect(isCircuitSupported("kyc")).toBe(true);
    expect(isCircuitSupported("age")).toBe(true);
    expect(isCircuitSupported("income")).toBe(true);
    expect(isCircuitSupported("composite_eligibility")).toBe(false);
    expect(isCircuitExperimental("composite_eligibility")).toBe(true);
    expect(isCircuitExperimental("set_membership")).toBe(true);
    expect(isCircuitSupported("non_existent")).toBe(false);
  });

  it("retrieves manifest entries by credentialType or circuit id", () => {
    const kycByType = getCircuitManifestEntry("kyc");
    const kycById = getCircuitManifestEntry("kyc_proof");
    expect(kycByType).not.toBeNull();
    expect(kycByType?.id).toBe("kyc_proof");
    expect(kycById?.credentialType).toBe("kyc");
    expect(kycByType?.publicInputs).toContain("commitment");
  });

  it("validates release artifacts correctly", () => {
    const supported = getSupportedCircuits();
    const validArtifacts: Record<string, { circuitVersion: string; vkVersion: number }> = {};
    for (const c of supported) {
      validArtifacts[c.credentialType] = {
        circuitVersion: c.version,
        vkVersion: c.vkVersion,
      };
    }

    const validationSuccess = validateReleaseArtifacts(validArtifacts);
    expect(validationSuccess.valid).toBe(true);
    expect(validationSuccess.errors.length).toBe(0);

    // Test missing artifact
    const incompleteArtifacts = { ...validArtifacts };
    delete (incompleteArtifacts as Record<string, unknown>)["kyc"];
    const validationMissing = validateReleaseArtifacts(incompleteArtifacts);
    expect(validationMissing.valid).toBe(false);
    expect(validationMissing.errors[0]).toMatch(/Missing compiled release artifact/);

    // Test version mismatch
    const mismatchedArtifacts = {
      ...validArtifacts,
      kyc: { circuitVersion: "2.0.0", vkVersion: 1 },
    };
    const validationMismatch = validateReleaseArtifacts(mismatchedArtifacts);
    expect(validationMismatch.valid).toBe(false);
    expect(validationMismatch.errors[0]).toMatch(/version mismatch/);
  });
});
