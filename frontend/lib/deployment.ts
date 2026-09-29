// Deployment identity for credentials (Issue #545).
//
// A credential is only usable inside the StellarCred deployment that issued
// it: proofs are verified against the issuer's key as registered in that
// deployment's IssuerRegistry and submitted to its ProofRegistry. Contract IDs
// differ per deployment, and network passphrase differs per Stellar network —
// so a credential minted elsewhere cannot prove here, no matter what the
// holder's device stores.
//
// Policy: cross-deployment import is NEVER valid. In particular
// testnet → mainnet (and any other network change) is always rejected. Two
// deployments on the same network with different contract IDs are also
// rejected, because the issuer registration and verifier don't carry over.
// Credentials minted before this field existed carry no deployment reference
// and cannot be checked — they import as before (legacy path).

import { CONTRACTS, NETWORK, NETWORK_PASSPHRASE, type StellarNetwork } from "./stellar";

/** The deployment a credential was issued against. */
export interface DeploymentRef {
  network: StellarNetwork;
  networkPassphrase: string;
  contracts: {
    issuerRegistry: string;
    credentialVerifier: string;
    proofRegistry: string;
    gatedPool: string;
  };
}

/** Snapshot of this app's effective deployment config. */
export function currentDeploymentRef(): DeploymentRef {
  return {
    network: NETWORK,
    networkPassphrase: NETWORK_PASSPHRASE,
    contracts: { ...CONTRACTS },
  };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Structural check for an untrusted `deployment` field. Returns null for
 * anything malformed or absent — a credential we can't classify is treated as
 * legacy (importable), never as a false mismatch.
 */
export function parseDeploymentRef(value: unknown): DeploymentRef | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isNonEmptyString(v.networkPassphrase)) return null;
  const contracts = v.contracts;
  if (!contracts || typeof contracts !== "object") return null;
  const c = contracts as Record<string, unknown>;
  const asId = (x: unknown) => (isNonEmptyString(x) ? x : "");
  return {
    network: isNonEmptyString(v.network) ? (v.network as StellarNetwork) : ("unknown" as StellarNetwork),
    networkPassphrase: v.networkPassphrase,
    contracts: {
      issuerRegistry: asId(c.issuerRegistry),
      credentialVerifier: asId(c.credentialVerifier),
      proofRegistry: asId(c.proofRegistry),
      gatedPool: asId(c.gatedPool),
    },
  };
}

const CONTRACT_LABELS: Record<keyof DeploymentRef["contracts"], string> = {
  issuerRegistry: "issuer registry",
  credentialVerifier: "credential verifier",
  proofRegistry: "proof registry",
  gatedPool: "gated pool",
};

/**
 * Compare a credential/backup's recorded origin against this deployment and
 * return a holder-facing error message, or null when the import may proceed.
 *
 * Only fields set on BOTH sides are compared: an empty contract ID means the
 * deployment didn't configure that contract, and comparing it would flag
 * unrelated apps against each other.
 */
export function deploymentMismatchMessage(
  stored: unknown,
  current: DeploymentRef = currentDeploymentRef(),
): string | null {
  const origin = parseDeploymentRef(stored);
  if (!origin) return null;

  if (origin.networkPassphrase !== current.networkPassphrase) {
    return (
      `This credential belongs to another deployment: it was issued on the ` +
      `"${origin.network}" network, but this app runs on "${current.network}" ` +
      `(${current.networkPassphrase}). Credentials cannot move between ` +
      `networks — for example, a testnet credential can never be proven on ` +
      `mainnet. Ask the issuer to re-issue it against this deployment.`
    );
  }

  const differing = (Object.keys(CONTRACT_LABELS) as Array<keyof DeploymentRef["contracts"]>)
    .filter(
      (key) =>
        origin.contracts[key] && current.contracts[key] && origin.contracts[key] !== current.contracts[key],
    )
    .map((key) => CONTRACT_LABELS[key]);

  if (differing.length > 0) {
    return (
      `This credential was issued by a different StellarCred deployment on ` +
      `the same "${current.network}" network (its ${differing.join(", ")} ` +
      `isn't the one this app is configured for). The issuer is not ` +
      `registered here, so the credential could never be proven on-chain — ` +
      `import is rejected. Re-issue it against this deployment instead.`
    );
  }

  return null;
}
