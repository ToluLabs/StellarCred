// On-chain contract version reads (issue #639).
//
// Every StellarCred contract exposes `version() -> u32`, encoding
// (major * 1_000_000) + (minor * 1_000) + patch. The descriptor at
// /api/capabilities reports the version the chain actually has, so a live
// deployment can never disagree with the DEPLOYMENTS.md registry even after
// an upgrade — unlike a hardcoded value, which drifts.
//
// Server-only: performs Soroban RPC simulations. Do not import from
// client code.

import { NETWORK_PASSPHRASE, RPC_URL } from "./stellar";

type SDK = typeof import("@stellar/stellar-sdk");

let sdkPromise: Promise<SDK> | null = null;
function sdk(): Promise<SDK> {
  if (!sdkPromise) sdkPromise = import("@stellar/stellar-sdk");
  return sdkPromise;
}

let server: InstanceType<SDK["rpc"]["Server"]> | null = null;
async function getServer() {
  if (!server) {
    const { rpc } = await sdk();
    server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
  }
  return server;
}

/** Decode a contract `version()` u32 into a semver string ("1.1.0"). */
export function decodeContractVersion(encoded: number): string {
  const major = Math.floor(encoded / 1_000_000);
  const minor = Math.floor((encoded % 1_000_000) / 1_000);
  const patch = encoded % 1_000;
  return `${major}.${minor}.${patch}`;
}

/**
 * Read a contract's on-chain version via read-only simulation.
 * Returns null when the call fails for any reason (RPC unreachable, account
 * unfunded, contract predates the version() entrypoint) — callers treat null
 * as "unknown", never as a mismatch.
 */
export async function fetchOnChainContractVersion(
  contractId: string,
  simulationAccount: string,
): Promise<string | null> {
  if (!contractId) return null;

  try {
    const { rpc, TransactionBuilder, BASE_FEE, Contract, scValToNative } = await sdk();
    const srv = await getServer();
    const account = await srv.getAccount(simulationAccount);
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .addOperation(contract.call("version") as any)
      .setTimeout(30)
      .build();

    const sim = await srv.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim) || !sim.result) return null;
    const raw = scValToNative(sim.result.retval);
    if (typeof raw !== "number" || raw < 0) return null;
    return decodeContractVersion(raw);
  } catch {
    return null;
  }
}
