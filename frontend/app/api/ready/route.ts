import { NextResponse } from "next/server";
import { RPC_URL, CONTRACTS } from "../../../lib/stellar";
import { missingContractEnvVars } from "../../../lib/config";
import { env } from "../../../lib/env";

export const dynamic = "force-dynamic";

interface DependencyStatus {
  status: "ok" | "error";
  message?: string;
}

interface SignerStatus extends DependencyStatus {
  /** "demo" = signing with the public demo issuer key; "configured" = ISSUER_PRIVATE_KEY set. */
  issuer: "demo" | "configured";
}

interface ContractVersion {
  address: string;
  version: string;
  status: "ok" | "error";
  message?: string;
}

interface ReadyResponse {
  ready: boolean;
  signer: SignerStatus;
  contracts: DependencyStatus;
  contract_versions?: Record<string, ContractVersion>;
  rpc: DependencyStatus;
  persona: DependencyStatus;
  app_version?: string;
  deployment_timestamp?: number;
}

async function checkRpc(): Promise<DependencyStatus> {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getNetwork" }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { status: "error", message: `HTTP ${res.status}` };
    }
    return { status: "ok" };
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
}

function checkSigner(): SignerStatus {
  if (!env.ISSUER_PRIVATE_KEY) {
    return {
      status: "error",
      message: "ISSUER_PRIVATE_KEY not set — signing with the public demo issuer key",
      issuer: "demo",
    };
  }
  return { status: "ok", issuer: "configured" };
}

function checkContracts(): DependencyStatus {
  // Same shared check the client-side ConfigBanner uses (lib/config.ts), so
  // readiness monitoring and the user-facing banner can never disagree on
  // which env vars are missing.
  const missing = missingContractEnvVars();
  if (missing.length > 0) {
    return { status: "error", message: `Missing: ${missing.join(", ")}` };
  }
  return { status: "ok" };
}

function checkPersona(): DependencyStatus {
  if (!env.PERSONA_API_KEY) {
    return { status: "ok", message: "not configured (demo mode)" };
  }
  // PERSONA_KYC_TEMPLATE_ID is already enforced at startup when PERSONA_API_KEY
  // is set (see lib/env.ts), so reaching here with PERSONA_API_KEY set means
  // it's present — this branch is unreachable in practice but kept as a
  // defensive fallback in case env validation is ever bypassed.
  if (!env.PERSONA_KYC_TEMPLATE_ID) {
    return { status: "error", message: "PERSONA_KYC_TEMPLATE_ID not set" };
  }
  return { status: "ok" };
}

/**
 * Fetch contract versions from deployed contracts.
 * Note: A full implementation would call the version() endpoint on each contract.
 * For now, this returns hardcoded versions matching Cargo.toml.
 */
async function fetchContractVersions(): Promise<Record<string, ContractVersion> | undefined> {
  // Only fetch versions if contracts are configured
  if (missingContractEnvVars().length > 0) {
    return undefined;
  }

  const versions: Record<string, ContractVersion> = {};

  // Build version map from deployed contract IDs
  // All contracts are currently at version 1.0.0
  const contractMap: Record<string, string> = {
    issuerRegistry: CONTRACTS.issuerRegistry,
    credentialVerifier: CONTRACTS.credentialVerifier,
    proofRegistry: CONTRACTS.proofRegistry,
    gatedPool: CONTRACTS.gatedPool,
  };

  for (const [name, address] of Object.entries(contractMap)) {
    if (address) {
      versions[name] = {
        address,
        version: "1.0.0", // Matches Cargo.toml versions
        status: "ok",
      };
    }
  }

  return Object.keys(versions).length > 0 ? versions : undefined;
}

export async function GET() {
  const [signer, contracts, rpc, persona, contractVersions] = await Promise.all([
    Promise.resolve(checkSigner()),
    Promise.resolve(checkContracts()),
    checkRpc(),
    Promise.resolve(checkPersona()),
    fetchContractVersions(),
  ]);

  const ready =
    signer.status === "ok" &&
    contracts.status === "ok" &&
    rpc.status === "ok" &&
    persona.status === "ok";

  const body: ReadyResponse = {
    ready,
    signer,
    contracts,
    rpc,
    persona,
  };

  // Add contract versions if available
  if (contractVersions) {
    body.contract_versions = contractVersions;
  }

  // Add app version from environment (will be set during deployment)
  body.app_version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
  body.deployment_timestamp = Date.now();

  return NextResponse.json(body, { status: ready ? 200 : 503 });
}