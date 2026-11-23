/**
 * circuit-manifest.ts - Versioned v1 credential-type support manifest (#972).
 *
 * Provides a definitive, reviewable list of supported circuit identifiers,
 * public-input schemas, VK versions, and compatibility status for each release.
 * Distinguishes officially supported circuits from experimental/staged circuits.
 */

export type CircuitSupportStatus = "supported" | "experimental" | "deprecated";

export interface SupportedCircuitMetadata {
  readonly id: string;
  readonly credentialType: string;
  readonly status: CircuitSupportStatus;
  readonly version: string;
  readonly vkVersion: number;
  readonly publicInputs: readonly string[];
  readonly constraints?: number;
  readonly compatibility: {
    readonly minAppVersion: string;
    readonly supportedContractVersions: readonly string[];
  };
}

export interface CircuitManifestDocument {
  readonly manifestVersion: string;
  readonly release: string;
  readonly publishedAt: string;
  readonly description: string;
  readonly circuits: readonly SupportedCircuitMetadata[];
}

export const SUPPORTED_CIRCUITS_MANIFEST: CircuitManifestDocument = {
  manifestVersion: "1.0.0",
  release: "v1.0.0",
  publishedAt: "2026-11-22T00:00:00Z",
  description:
    "Authoritative release manifest of supported and experimental zero-knowledge circuits for StellarCred v1.0.0 (#972).",
  circuits: [
    {
      id: "kyc_proof",
      credentialType: "kyc",
      status: "supported",
      version: "1.0.0",
      vkVersion: 1,
      publicInputs: ["commitment", "issuer_pub_x", "issuer_pub_y", "merkle_root"],
      constraints: 4200,
      compatibility: {
        minAppVersion: "1.0.0",
        supportedContractVersions: ["1.0.0"],
      },
    },
    {
      id: "age_proof",
      credentialType: "age",
      status: "supported",
      version: "1.0.0",
      vkVersion: 1,
      publicInputs: [
        "commitment",
        "threshold_years",
        "current_date",
        "issuer_pub_x",
        "issuer_pub_y",
      ],
      constraints: 4500,
      compatibility: {
        minAppVersion: "1.0.0",
        supportedContractVersions: ["1.0.0"],
      },
    },
    {
      id: "income_proof",
      credentialType: "income",
      status: "supported",
      version: "1.0.0",
      vkVersion: 1,
      publicInputs: ["commitment", "min_income", "issuer_pub_x", "issuer_pub_y"],
      constraints: 4300,
      compatibility: {
        minAppVersion: "1.0.0",
        supportedContractVersions: ["1.0.0"],
      },
    },
    {
      id: "jurisdiction_proof",
      credentialType: "jurisdiction",
      status: "supported",
      version: "1.0.0",
      vkVersion: 1,
      publicInputs: ["commitment", "mode", "country_code", "issuer_pub_x", "issuer_pub_y"],
      constraints: 4400,
      compatibility: {
        minAppVersion: "1.0.0",
        supportedContractVersions: ["1.0.0"],
      },
    },
    {
      id: "funds_proof",
      credentialType: "funds",
      status: "supported",
      version: "1.0.0",
      vkVersion: 1,
      publicInputs: ["commitment", "min_balance", "issuer_pub_x", "issuer_pub_y"],
      constraints: 4300,
      compatibility: {
        minAppVersion: "1.0.0",
        supportedContractVersions: ["1.0.0"],
      },
    },
    {
      id: "accreditation_proof",
      credentialType: "accreditation",
      status: "supported",
      version: "1.0.0",
      vkVersion: 1,
      publicInputs: ["commitment", "accreditation_type", "issuer_pub_x", "issuer_pub_y"],
      constraints: 4350,
      compatibility: {
        minAppVersion: "1.0.0",
        supportedContractVersions: ["1.0.0"],
      },
    },
    {
      id: "employment_proof",
      credentialType: "employment",
      status: "supported",
      version: "1.0.0",
      vkVersion: 1,
      publicInputs: ["commitment", "min_seniority", "issuer_pub_x", "issuer_pub_y"],
      constraints: 4400,
      compatibility: {
        minAppVersion: "1.0.0",
        supportedContractVersions: ["1.0.0"],
      },
    },
    {
      id: "aggregate_proof",
      credentialType: "aggregate",
      status: "supported",
      version: "1.0.0",
      vkVersion: 1,
      publicInputs: ["commitments_root", "proof_flags", "issuer_pub_x", "issuer_pub_y"],
      constraints: 9800,
      compatibility: {
        minAppVersion: "1.0.0",
        supportedContractVersions: ["1.0.0"],
      },
    },
    {
      id: "composite_eligibility_proof",
      credentialType: "composite_eligibility",
      status: "experimental",
      version: "0.1.0-alpha",
      vkVersion: 1,
      publicInputs: ["policy_hash", "outcome"],
      constraints: 12000,
      compatibility: {
        minAppVersion: "1.1.0-alpha",
        supportedContractVersions: ["1.0.0"],
      },
    },
    {
      id: "set_membership",
      credentialType: "set_membership",
      status: "experimental",
      version: "0.1.0-alpha",
      vkVersion: 1,
      publicInputs: ["merkle_root", "leaf_hash"],
      constraints: 5000,
      compatibility: {
        minAppVersion: "1.1.0-alpha",
        supportedContractVersions: ["1.0.0"],
      },
    },
  ],
};

/**
 * Returns all circuits marked with status "supported".
 */
export function getSupportedCircuits(): SupportedCircuitMetadata[] {
  return SUPPORTED_CIRCUITS_MANIFEST.circuits.filter((c) => c.status === "supported");
}

/**
 * Returns true if the circuit or credential type is officially supported in this release.
 */
export function isCircuitSupported(identifier: string): boolean {
  const match = SUPPORTED_CIRCUITS_MANIFEST.circuits.find(
    (c) => c.credentialType === identifier || c.id === identifier,
  );
  return match?.status === "supported";
}

/**
 * Returns true if the circuit is marked as experimental.
 */
export function isCircuitExperimental(identifier: string): boolean {
  const match = SUPPORTED_CIRCUITS_MANIFEST.circuits.find(
    (c) => c.credentialType === identifier || c.id === identifier,
  );
  return match?.status === "experimental";
}

/**
 * Looks up the manifest entry for a circuit by either credential type or circuit ID.
 */
export function getCircuitManifestEntry(identifier: string): SupportedCircuitMetadata | null {
  const match = SUPPORTED_CIRCUITS_MANIFEST.circuits.find(
    (c) => c.credentialType === identifier || c.id === identifier,
  );
  return match ?? null;
}

/**
 * Validates a map of compiled circuit artifacts against the supported manifest.
 * Ensures all supported circuits are present and declare matching versions and VK IDs.
 */
export function validateReleaseArtifacts(
  compiledArtifacts: Record<string, { circuitVersion?: string; vkVersion?: number }>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const supported = getSupportedCircuits();

  for (const circuit of supported) {
    const artifact = compiledArtifacts[circuit.credentialType];
    if (!artifact) {
      errors.push(
        `Missing compiled release artifact for supported circuit "${circuit.credentialType}"`,
      );
      continue;
    }

    if (artifact.circuitVersion !== circuit.version) {
      errors.push(
        `Artifact "${circuit.credentialType}" version mismatch: expected ${circuit.version}, got ${artifact.circuitVersion}`,
      );
    }

    if (artifact.vkVersion !== circuit.vkVersion) {
      errors.push(
        `Artifact "${circuit.credentialType}" VK version mismatch: expected ${circuit.vkVersion}, got ${artifact.vkVersion}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
