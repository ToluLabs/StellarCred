// Capability descriptor (issue #639) — one machine-readable summary of what
// a deployment supports, so integrators and the SDK can configure themselves
// from a single URL instead of docs-reading and contract-ID copy-pasting.
//
// Served by app/api/capabilities/route.ts. Public and cacheable: the payload
// contains nothing sensitive — only values already readable from the chain
// or explicitly marked public. Server-only module: it reads SPONSOR_SECRET
// and performs RPC simulations.
//
// Every value is derived from the same shared config as /api/ready, the
// ConfigBanner, and /api/issuers (lib/stellar.ts / lib/config.ts), so the
// descriptor can never disagree with the rest of the app.

import {
  CONTRACTS,
  CREDENTIAL_TYPES,
  NETWORK,
  NETWORK_PASSPHRASE,
  RPC_URL,
  SPONSOR_ACCOUNT_ID,
  type CredentialType,
  type StellarNetwork,
} from "./stellar";
import { fetchRegisteredIssuers } from "./issuer-registry";
import { fetchOnChainContractVersion } from "./contract-versions";
import { env } from "./env";

export const CAPABILITIES_DESCRIPTOR_VERSION = 1;

/**
 * @stellarcred/sdk versions this deployment's contracts are known to work
 * against. Bump when contract/SDK behaviour drifts (see DEPLOYMENTS.md).
 */
export const SUPPORTED_SDK_VERSION_RANGE = ">=0.1.1 <1";

/** Public + CDN/browser cacheable — the payload contains nothing sensitive. */
export const CAPABILITIES_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=600";

export type CapabilitiesContractKey =
  | "issuer_registry"
  | "credential_verifier"
  | "proof_registry"
  | "gated_pool";

const CONTRACT_KEYS: Array<{
  descriptor: CapabilitiesContractKey;
  config: keyof typeof CONTRACTS;
}> = [
  { descriptor: "issuer_registry", config: "issuerRegistry" },
  { descriptor: "credential_verifier", config: "credentialVerifier" },
  { descriptor: "proof_registry", config: "proofRegistry" },
  { descriptor: "gated_pool", config: "gatedPool" },
];

export interface CapabilitiesContract {
  id: string;
  /** On-chain `version()` result; null when the chain is unreachable. */
  version: string | null;
}

export interface CapabilitiesIssuerSummary {
  count: number;
  /** Union of credential types the registered, non-revoked issuers serve. */
  credential_types: CredentialType[];
}

export interface CapabilitiesDescriptor {
  descriptor_version: number;
  app_version: string;
  network: { id: StellarNetwork; passphrase: string; rpc_url: string };
  contracts: Record<CapabilitiesContractKey, CapabilitiesContract | null>;
  /** Credential types the platform supports (contract Symbols). */
  credential_types: CredentialType[];
  /** Registered-issuer summary; null when the registry is unreachable. */
  issuers: CapabilitiesIssuerSummary | null;
  /** Present only when a public indexer URL is configured. */
  indexer: { url: string } | null;
  sponsored_submission: { available: boolean };
  sdk: { package: string; version_range: string };
}

// Any existing account works as the source for read-only simulations — same
// pattern as app/api/issuers/route.ts.
const SIMULATION_ACCOUNT_FALLBACK =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function simulationAccount(): string {
  return env.NEXT_PUBLIC_ISSUER_ADDRESS || SIMULATION_ACCOUNT_FALLBACK;
}

async function buildContracts(simAccount: string): Promise<CapabilitiesDescriptor["contracts"]> {
  const entries = await Promise.all(
    CONTRACT_KEYS.map(async ({ descriptor, config }) => {
      const id = CONTRACTS[config];
      if (!id) return [descriptor, null] as const;
      const version = await fetchOnChainContractVersion(id, simAccount);
      return [descriptor, { id, version }] as const;
    }),
  );
  return Object.fromEntries(entries) as CapabilitiesDescriptor["contracts"];
}

async function buildIssuerSummary(
  simAccount: string,
): Promise<CapabilitiesDescriptor["issuers"]> {
  if (!CONTRACTS.issuerRegistry) return null;
  try {
    const issuers = await fetchRegisteredIssuers(simAccount);
    const served = new Set<string>();
    for (const issuer of issuers) {
      for (const type of issuer.credentialTypes) served.add(type);
    }
    return {
      count: issuers.length,
      credential_types: CREDENTIAL_TYPES.filter((t) => served.has(t)),
    };
  } catch {
    // RPC unreachable etc. — "unknown", not "no issuers".
    return null;
  }
}

export async function buildCapabilitiesDescriptor(): Promise<CapabilitiesDescriptor> {
  const simAccount = simulationAccount();
  const [contracts, issuers] = await Promise.all([
    buildContracts(simAccount),
    buildIssuerSummary(simAccount),
  ]);

  return {
    descriptor_version: CAPABILITIES_DESCRIPTOR_VERSION,
    app_version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
    network: { id: NETWORK, passphrase: NETWORK_PASSPHRASE, rpc_url: RPC_URL },
    contracts,
    credential_types: [...CREDENTIAL_TYPES],
    issuers,
    indexer: env.NEXT_PUBLIC_INDEXER_URL ? { url: env.NEXT_PUBLIC_INDEXER_URL } : null,
    sponsored_submission: {
      // Same predicate as the /api/sponsor relay: both the public sponsor
      // account and the server-only secret must be present.
      available: Boolean(SPONSOR_ACCOUNT_ID) && Boolean(process.env.SPONSOR_SECRET),
    },
    sdk: { package: "@stellarcred/sdk", version_range: SUPPORTED_SDK_VERSION_RANGE },
  };
}
