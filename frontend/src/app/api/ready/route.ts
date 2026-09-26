import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface DependencyStatus {
  signerConfigured: boolean;
  contractIdsConfigured: boolean;
  personaConfigured: boolean;
  rpc: 'ok' | 'error';
}

async function checkRpcHealth(rpcUrl: string | undefined): Promise<'ok' | 'error'> {
  if (!rpcUrl) return 'error';

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'health-check',
        method: 'getHealth',
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) return 'error';
    const data = await response.json();
    return data?.result?.status === 'healthy' || data?.result ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

export async function GET() {
  const rpcUrl = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || process.env.SOROBAN_RPC_URL;
  const signerKey = process.env.ISSUER_SECRET_KEY || process.env.SIGNER_SECRET_KEY;
  const proofRegistryContractId =
    process.env.NEXT_PUBLIC_PROOF_REGISTRY_CONTRACT_ID || process.env.PROOF_REGISTRY_CONTRACT_ID;
  const personaApiKey = process.env.PERSONA_API_KEY;

  const signerConfigured = Boolean(signerKey && signerKey.trim().length > 0);
  const contractIdsConfigured = Boolean(
    proofRegistryContractId && proofRegistryContractId.trim().length > 0
  );
  const personaConfigured = Boolean(personaApiKey && personaApiKey.trim().length > 0);

  const rpcStatus = await checkRpcHealth(rpcUrl);

  const isReady = signerConfigured && contractIdsConfigured && rpcStatus === 'ok';

  const dependencies: DependencyStatus = {
    signerConfigured,
    contractIdsConfigured,
    personaConfigured,
    rpc: rpcStatus,
  };

  return NextResponse.json(
    {
      status: isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      dependencies,
    },
    { status: isReady ? 200 : 503 }
  );
}
