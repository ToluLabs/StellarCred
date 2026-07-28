import { Buffer } from "buffer";
import { RPC_URL, NETWORK_PASSPHRASE, CONTRACTS } from "./stellar";
import type { CredentialType } from "./stellar";
import { truncateAddress } from "./format";

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

export interface RegisteredIssuer {
  id: string;
  name: string;
  pubkeyHex: string;
  credentialTypes: CredentialType[];
  revoked: boolean;
}

function issuerNameMap(): Record<string, string> {
  const raw = process.env.NEXT_PUBLIC_ISSUER_NAMES;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export function issuerDisplayName(id: string): string {
  return issuerNameMap()[id] ?? truncateAddress(id);
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

async function simulate<T>(accountId: string, op: unknown): Promise<T | null> {
  if (!CONTRACTS.issuerRegistry) return null;

  const { rpc, TransactionBuilder, BASE_FEE, scValToNative } = await sdk();
  const srv = await getServer();

  let account;
  try {
    account = await srv.getAccount(accountId);
  } catch {
    return null;
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addOperation(op as any)
    .setTimeout(30)
    .build();

  const sim = await srv.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) return null;
  return scValToNative(sim.result.retval) as T;
}

interface OnChainIssuer {
  pubkey: Uint8Array;
  credential_types: string[];
  revoked: boolean;
}

/** Read all active issuers from IssuerRegistry via Soroban simulation. */
export async function fetchRegisteredIssuers(
  simulationAccount: string,
): Promise<RegisteredIssuer[]> {
  if (!CONTRACTS.issuerRegistry) return [];

  const { Contract } = await sdk();
  const contract = new Contract(CONTRACTS.issuerRegistry);
  const ids = (await simulate<string[]>(simulationAccount, contract.call("get_issuers"))) ?? [];
  const names = issuerNameMap();
  const issuers: RegisteredIssuer[] = [];

  for (const id of ids) {
    const address = String(id);
    const { Address } = await sdk();
    const record = await simulate<OnChainIssuer>(
      simulationAccount,
      contract.call("get_issuer", Address.fromString(address).toScVal()),
    );
    if (!record || record.revoked) continue;

    issuers.push({
      id: address,
      name: names[address] ?? truncateAddress(address),
      pubkeyHex: bytesToHex(record.pubkey),
      credentialTypes: record.credential_types.filter((t): t is CredentialType =>
        ["kyc", "age", "jurisdiction", "income", "funds"].includes(t),
      ),
      revoked: record.revoked,
    });
  }

  return issuers;
}

/** Fetch the registered secp256k1 public key (x || y, 64 bytes) for an issuer. */
export async function fetchIssuerPubkey(
  issuerId: string,
  simulationAccount: string,
): Promise<Uint8Array | null> {
  if (!CONTRACTS.issuerRegistry) return null;

  const { Contract, Address } = await sdk();
  const contract = new Contract(CONTRACTS.issuerRegistry);
  const pubkey = await simulate<Uint8Array>(
    simulationAccount,
    contract.call("get_issuer_pubkey", Address.fromString(issuerId).toScVal()),
  );
  return pubkey ?? null;
}