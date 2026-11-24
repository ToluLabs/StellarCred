/**
 * version.ts — SDK helpers for inspecting deployment and circuit version metadata.
 *
 * Issue #841: The app stamps deployment and circuit versions onto credentials at
 * issuance time, but the SDK did not previously expose a first-class way to read
 * or compare them. This module fills that gap.
 *
 * ## Usage
 *
 * ```ts
 * import { getCredentialCircuitVersion, isCompatibleCredential } from "@stellarcred/sdk/version";
 * // or from the main entry point:
 * import { getCredentialCircuitVersion, isCompatibleCredential } from "@stellarcred/sdk";
 * ```
 *
 * ## Compatibility check pattern
 *
 * Before submitting a proof flow, check whether the credential is compatible
 * with the current circuit version. If not, prompt the holder to re-verify:
 *
 * ```ts
 * import StellarCred, { isCompatibleCredential } from "@stellarcred/sdk";
 *
 * const status = StellarCred.getCredentialVersionStatus(credential);
 * if (status !== "compatible") {
 *   // Prompt the holder to re-verify
 *   showReVerifyPrompt(status);
 * }
 * ```
 *
 * ## Types
 *
 * ```ts
 * interface CredentialVersionInfo {
 *   circuitVersion: string | null;   // e.g. "1.0.0-beta.9+0.87.0"
 *   network: string | null;          // e.g. "testnet"
 *   proofRegistryId: string | null;  // e.g. "C..."
 *   issuedAt: number | null;         // unix seconds
 * }
 *
 * type CredentialVersionStatus =
 *   | "compatible"    // version matches; safe to prove
 *   | "incompatible"  // version differs; holder must re-verify
 *   | "legacy"        // no deployment field; compatibility unknown
 *   | "unknown";      // deployment not in known registry
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The deployment reference stamped on a credential by /api/issue at mint time.
 * Structurally matches `frontend/lib/deployment.ts#DeploymentRef` so
 * credentials from the app and credentials from SDK-consuming apps interoperate.
 */
export interface CredentialDeployment {
  network: string;
  networkPassphrase: string;
  contracts: {
    issuerRegistry: string;
    credentialVerifier: string;
    proofRegistry: string;
    gatedPool: string;
  };
}

/**
 * A credential object with the fields required for version checks.
 * Intentionally minimal so this helper works with any credential-like object,
 * not just the full `Credential` type from the app.
 */
export interface VersionableCredential {
  deployment?: CredentialDeployment | null;
  issuedAt?: number | null;
}

/**
 * Structured version information extracted from a credential.
 */
export interface CredentialVersionInfo {
  /**
   * The circuit version tag for the deployment this credential was issued
   * against, e.g. `"1.0.0-beta.9+0.87.0"`. `null` for legacy credentials
   * (no deployment field) or unrecognised deployments.
   */
  circuitVersion: string | null;
  /** The Stellar network the credential was issued on, e.g. `"testnet"`. */
  network: string | null;
  /** The ProofRegistry contract ID for the credential's deployment. */
  proofRegistryId: string | null;
  /** Unix timestamp (seconds) when the credential was issued, if present. */
  issuedAt: number | null;
}

/**
 * Compatibility status of a credential against the current circuit version.
 *
 * - `"compatible"`   — version matches; the credential can be submitted for proof.
 * - `"incompatible"` — version differs; the holder must re-verify to generate a
 *                      proof compatible with the current circuit.
 * - `"legacy"`       — no deployment field; compatibility cannot be determined.
 *                      Treat as incompatible in security-sensitive contexts.
 * - `"unknown"`      — deployment is present but not in the known version registry.
 */
export type CredentialVersionStatus =
  | "compatible"
  | "incompatible"
  | "legacy"
  | "unknown";

// ---------------------------------------------------------------------------
// Circuit version registry
// ---------------------------------------------------------------------------

/**
 * Known circuit versions, keyed by `{network}:{proofRegistryContractId}`.
 *
 * Protocols integrating StellarCred can extend this map with their own
 * deployment entries, or compare against a version they receive out-of-band
 * (e.g. from the StellarCred deployment registry at DEPLOYMENTS.md).
 *
 * Version tag format: `{noir_version}+{bb_version}` — matches the tool
 * versions in `.github/workflows/ci.yml`.
 */
export const KNOWN_CIRCUIT_VERSIONS: Record<string, string> = {
  "testnet:C000000000000000000000000000000000000000000000000000000000000001":
    "1.0.0-beta.9+0.87.0",
};

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Extract structured version information from a credential.
 *
 * Returns `null` values for any field that is absent or unrecognised.
 *
 * @example
 * const info = getCredentialCircuitVersion(credential);
 * console.log(info.circuitVersion); // "1.0.0-beta.9+0.87.0" or null
 * console.log(info.network);        // "testnet" or null
 */
export function getCredentialCircuitVersion(
  credential: VersionableCredential,
): CredentialVersionInfo {
  if (!credential.deployment) {
    return {
      circuitVersion: null,
      network: null,
      proofRegistryId: null,
      issuedAt: credential.issuedAt ?? null,
    };
  }

  const { deployment } = credential;
  const key = `${deployment.network}:${deployment.contracts.proofRegistry}`;
  const circuitVersion = KNOWN_CIRCUIT_VERSIONS[key] ?? null;

  return {
    circuitVersion,
    network: deployment.network,
    proofRegistryId: deployment.contracts.proofRegistry,
    issuedAt: credential.issuedAt ?? null,
  };
}

/**
 * Returns `true` if a credential is compatible with the given circuit version.
 *
 * Compatibility means the credential's deployment maps to a circuit version
 * tag that exactly matches `expectedVersion`. Legacy credentials (no
 * deployment field) and credentials from unrecognised deployments return
 * `false`.
 *
 * @param credential  The credential to check.
 * @param expectedVersion  The circuit version string to compare against.
 *   Obtain the current version from `getDeploymentCircuitVersion()` or from
 *   the StellarCred deployment registry.
 *
 * @example
 * const current = await StellarCred.getDeploymentCircuitVersion("testnet", proofRegistryId);
 * if (!isCompatibleCredential(credential, current)) {
 *   promptReVerify(credential);
 * }
 */
export function isCompatibleCredential(
  credential: VersionableCredential,
  expectedVersion: string,
): boolean {
  const { circuitVersion } = getCredentialCircuitVersion(credential);
  if (!circuitVersion) return false;
  return circuitVersion === expectedVersion;
}

/**
 * Returns the compatibility status of a credential as a typed discriminant.
 *
 * Use this in UI code to render the appropriate prompt:
 *
 * ```ts
 * switch (getCredentialVersionStatus(credential, currentVersion)) {
 *   case "compatible":    break; // nothing to do
 *   case "incompatible":  showReVerifyBanner(); break;
 *   case "legacy":        showLegacyWarning(); break;
 *   case "unknown":       showUnknownDeploymentError(); break;
 * }
 * ```
 */
export function getCredentialVersionStatus(
  credential: VersionableCredential,
  expectedVersion: string,
): CredentialVersionStatus {
  if (!credential.deployment) return "legacy";
  const { circuitVersion } = getCredentialCircuitVersion(credential);
  if (!circuitVersion) return "unknown";
  return circuitVersion === expectedVersion ? "compatible" : "incompatible";
}

/**
 * Look up the circuit version for a specific deployment without needing a
 * credential — useful for protocols that want to display the current version
 * or validate before the holder has presented a credential.
 *
 * @param network  Stellar network identifier (e.g. `"testnet"`, `"mainnet"`).
 * @param proofRegistryId  The ProofRegistry contract ID for this deployment.
 *
 * @returns The version tag string, or `null` if the deployment is not in the
 *   known registry.
 *
 * @example
 * const version = getDeploymentCircuitVersion("testnet", env.PROOF_REGISTRY_ID);
 * // "1.0.0-beta.9+0.87.0"
 */
export function getDeploymentCircuitVersion(
  network: string,
  proofRegistryId: string,
): string | null {
  const key = `${network}:${proofRegistryId}`;
  return KNOWN_CIRCUIT_VERSIONS[key] ?? null;
}
