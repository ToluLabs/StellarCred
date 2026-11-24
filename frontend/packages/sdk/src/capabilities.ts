// Capability-descriptor bootstrap (issue #639).
//
// A deployment publishes its machine-readable capability descriptor at
// GET {base}/api/capabilities: network, contract IDs + on-chain versions,
// supported credential types, registered-issuer summary, optional public
// indexer URL, sponsored-submission availability, and the SDK version range
// known to work. `bootstrap()` fetches it once and configures the SDK, so an
// integrator supplies one URL (the deployment base URL) instead of a set of
// contract IDs. The descriptor is public, cacheable, and contains nothing
// sensitive; it must agree with the DEPLOYMENTS.md registry record.

import { ConfigError, configure, getConfig } from "./claims";

/** One deployed contract entry in the descriptor. */
export interface CapabilitiesContractEntry {
  id: string;
  version?: string | null;
}

export type CapabilitiesContractKey =
  | "issuer_registry"
  | "credential_verifier"
  | "proof_registry"
  | "gated_pool";

/** Shape of GET {base}/api/capabilities. Only fields the SDK uses are required. */
export interface CapabilitiesDescriptor {
  descriptor_version: number;
  app_version?: string;
  network: {
    id?: string;
    passphrase?: string;
    rpc_url?: string;
  };
  contracts?: Partial<Record<CapabilitiesContractKey, CapabilitiesContractEntry | null>>;
  credential_types?: string[];
  issuers?: { count: number; credential_types?: string[] } | null;
  indexer?: { url: string } | null;
  sponsored_submission?: { available: boolean };
  sdk?: { package?: string; version_range?: string };
}

export interface BootstrapOptions {
  /** Full descriptor URL. Defaults to `{baseUrl}/api/capabilities`. */
  descriptorUrl?: string;
  requestTimeoutMs?: number;
  /** Test seam — override the global fetch. */
  fetchImpl?: typeof fetch;
}

export function validateCapabilitiesDescriptor(raw: unknown): CapabilitiesDescriptor {
  const fail = (detail: string): never => {
    throw new ConfigError(`Invalid capability descriptor: ${detail}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("expected a JSON object");
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.descriptor_version !== "number" || d.descriptor_version < 1) {
    fail("descriptor_version must be a positive number");
  }
  if (!d.network || typeof d.network !== "object" || Array.isArray(d.network)) {
    fail("network object is missing");
  }
  const network = d.network as Record<string, unknown>;
  if (typeof network.passphrase !== "string" || network.passphrase.length === 0) {
    fail("network.passphrase must be a non-empty string");
  }
  if (d.contracts !== undefined) {
    if (!d.contracts || typeof d.contracts !== "object" || Array.isArray(d.contracts)) {
      fail("contracts must be an object");
    }
  }
  return raw as CapabilitiesDescriptor;
}

/** Default descriptor URL for a deployment base URL: `{base}/api/capabilities`. */
export function capabilitiesUrl(baseUrl?: string): string {
  const base = (baseUrl ?? getConfig().baseUrl).replace(/\/+$/, "");
  return `${base}/api/capabilities`;
}

/**
 * Fetch and validate the capability descriptor from a deployment. Throws
 * ConfigError on network failure, non-2xx, invalid JSON, or a malformed
 * payload.
 */
export async function fetchCapabilities(
  opts: BootstrapOptions = {},
): Promise<CapabilitiesDescriptor> {
  const url = opts.descriptorUrl ?? capabilitiesUrl();
  const timeoutMs = opts.requestTimeoutMs ?? getConfig().requestTimeoutMs;
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ConfigError(
      `Failed to fetch capability descriptor at ${url}: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new ConfigError(`Capability descriptor at ${url} returned HTTP ${res.status}`);
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (e) {
    throw new ConfigError(
      `Capability descriptor at ${url} is not valid JSON: ${(e as Error).message}`,
    );
  }
  return validateCapabilitiesDescriptor(raw);
}

/**
 * Configure the SDK from a deployment's capability descriptor — the one-URL
 * setup path. Applies the ProofRegistry contract ID (registryId), and the
 * RPC URL / network passphrase when the descriptor provides them.
 *
 * @example
 * await StellarCred.bootstrap({ descriptorUrl: "https://app.example.com/api/capabilities" });
 * await StellarCred.hasClaim(wallet, "kyc");
 */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<CapabilitiesDescriptor> {
  const descriptor = await fetchCapabilities(opts);

  const proofRegistry = descriptor.contracts?.proof_registry;
  if (!proofRegistry || typeof proofRegistry.id !== "string" || proofRegistry.id === "") {
    throw new ConfigError(
      "Capability descriptor has no proof_registry contract ID — cannot bootstrap",
    );
  }

  configure({
    registryId: proofRegistry.id,
    ...(descriptor.network.rpc_url ? { rpcUrl: descriptor.network.rpc_url } : {}),
    ...(descriptor.network.passphrase ? { networkPassphrase: descriptor.network.passphrase } : {}),
  });
  return descriptor;
}
