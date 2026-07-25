import { NextResponse } from "next/server";
import { RPC_URL, CONTRACTS } from "../../../lib/stellar";

export const dynamic = "force-dynamic";

interface DependencyStatus {
  status: "ok" | "error";
  message?: string;
}

interface ReadyResponse {
  ready: boolean;
  signer: DependencyStatus;
  contracts: DependencyStatus;
  rpc: DependencyStatus;
  persona: DependencyStatus;
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

function checkSigner(): DependencyStatus {
  if (!process.env.ISSUER_PRIVATE_KEY) {
    return { status: "error", message: "ISSUER_PRIVATE_KEY not set" };
  }
  return { status: "ok" };
}

function checkContracts(): DependencyStatus {
  const missing = Object.entries(CONTRACTS)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    return { status: "error", message: `Missing: ${missing.join(", ")}` };
  }
  return { status: "ok" };
}

function checkPersona(): DependencyStatus {
  if (!process.env.PERSONA_API_KEY) {
    return { status: "ok", message: "not configured (demo mode)" };
  }
  if (!process.env.PERSONA_KYC_TEMPLATE_ID) {
    return { status: "error", message: "PERSONA_KYC_TEMPLATE_ID not set" };
  }
  return { status: "ok" };
}

export async function GET() {
  const [signer, contracts, rpc, persona] = await Promise.all([
    Promise.resolve(checkSigner()),
    Promise.resolve(checkContracts()),
    checkRpc(),
    Promise.resolve(checkPersona()),
  ]);

  const ready =
    signer.status === "ok" &&
    contracts.status === "ok" &&
    rpc.status === "ok" &&
    persona.status === "ok";

  const body: ReadyResponse = { ready, signer, contracts, rpc, persona };

  return NextResponse.json(body, { status: ready ? 200 : 503 });
}
