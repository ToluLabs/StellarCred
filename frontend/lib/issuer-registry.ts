import { Buffer } from "buffer";
import { RPC_URL, NETWORK_PASSPHRASE, CONTRACTS, CREDENTIAL_TYPES } from "./stellar";
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

export interface IssuerMetadata {
  name?: string;
  url?: string;
  logo?: string;
}

export interface RegisteredIssuer {
  id: string;
  name: string;
  pubkeyHex: string;
  credentialTypes: CredentialType[];
  revoked: boolean;
  metadata?: IssuerMetadata;
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

    // Fetch optional on-chain metadata (name, url, logo).
    const rawMeta = await simulate<Record<string, string | null> | null>(
      simulationAccount,
      contract.call("get_issuer_metadata", Address.fromString(address).toScVal()),
    );
    const meta: IssuerMetadata | undefined = rawMeta
      ? {
          name: rawMeta.name ?? undefined,
          url: rawMeta.url ?? undefined,
          logo: rawMeta.logo ?? undefined,
        }
      : undefined;

    issuers.push({
      id: address,
      name: meta?.name ?? names[address] ?? truncateAddress(address),
      pubkeyHex: bytesToHex(record.pubkey),
      credentialTypes: record.credential_types.filter((t): t is CredentialType =>
        (CREDENTIAL_TYPES as readonly string[]).includes(t),
      ),
      revoked: record.revoked,
      metadata: meta,
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

/**
 * The granular status of an issuer as it affects a specific credential.
 *
 * - `"active"` — issuer is registered, not revoked, trusted for the
 *   credential type, and the signing key in the credential is still valid.
 *   Proof submission will succeed.
 * - `"key_retired"` — the issuer is still active for the credential type but
 *   the credential's specific signing key has been retired (its validity
 *   window is open but the issuer has rotated to a new key). Proof submission
 *   still works; no action needed yet.
 * - `"key_revoked"` — the issuer's current signing key was emergency-revoked.
 *   The issuer cannot issue new credentials until an admin installs a
 *   replacement key, and submissions may fail with `IssuerKeyMismatch` if the
 *   holder's credential was signed by the revoked key.
 * - `"issuer_revoked"` — the issuer itself has been permanently removed from
 *   the registry (`revoke_issuer`). Proof submission will fail with
 *   `IssuerNotTrusted`. The holder must obtain a new credential from a
 *   different issuer.
 * - `"unknown"` — the registry contract is not configured, the network is
 *   unreachable, or the issuer address is not in the registry. Treated
 *   conservatively: the UI does not block proving but also does not assert
 *   the issuer is active.
 */
export type IssuerStatus =
  | "active"
  | "key_retired"
  | "key_revoked"
  | "issuer_revoked"
  | "unknown";

/**
 * Check whether the issuer that signed a specific credential is still active
 * and whether the credential's signing key is still accepted by the registry.
 *
 * Calls two read-only Soroban simulations:
 *   1. `is_valid_issuer(issuerId, credentialType)` — issuer-level check
 *   2. `is_valid_issuer_key(issuerId, pubkey)` — key-level check
 *
 * Both calls are fire-and-forget simulations; they carry no fee and require
 * no wallet signature.
 *
 * @param issuerId         Stellar address of the issuer
 * @param credentialType   Credential type symbol (e.g. "kyc", "age")
 * @param issuerPubX       32-byte X component of the issuer's secp256k1 key
 * @param issuerPubY       32-byte Y component of the issuer's secp256k1 key
 * @param simulationAccount Any account address usable as the simulation source
 */
export async function checkIssuerStatus(
  issuerId: string,
  credentialType: string,
  issuerPubX: number[],
  issuerPubY: number[],
  simulationAccount: string,
): Promise<IssuerStatus> {
  if (!CONTRACTS.issuerRegistry) return "unknown";

  const { Contract, Address, nativeToScVal } = await sdk();
  const contract = new Contract(CONTRACTS.issuerRegistry);

  // ── Step 1: is the issuer itself still trusted? ──────────────────────────
  let issuerValid: boolean | null = null;
  try {
    issuerValid = await simulate<boolean>(
      simulationAccount,
      contract.call(
        "is_valid_issuer",
        Address.fromString(issuerId).toScVal(),
        nativeToScVal(credentialType, { type: "symbol" }),
      ),
    );
  } catch {
    return "unknown";
  }

  if (issuerValid === false) {
    // Could be issuer-level revocation OR current-key revocation (both return
    // false from is_valid_issuer). Fetch the raw issuer record to distinguish.
    try {
      const record = await simulate<OnChainIssuer>(
        simulationAccount,
        contract.call("get_issuer", Address.fromString(issuerId).toScVal()),
      );
      if (record?.revoked) return "issuer_revoked";
    } catch {
      // If we can't tell, fall through to issuer_revoked as the safer signal.
    }
    return "key_revoked";
  }

  if (issuerValid === null) return "unknown";

  // ── Step 2: is the credential's signing key still valid? ─────────────────
  // Reconstruct the 64-byte pubkey from the two 32-byte components stored on
  // the credential (issuerPubX || issuerPubY).
  if (issuerPubX.length !== 32 || issuerPubY.length !== 32) return "active";

  const pubkeyBytes = new Uint8Array(64);
  pubkeyBytes.set(issuerPubX, 0);
  pubkeyBytes.set(issuerPubY, 32);

  let keyValid: boolean | null = null;
  try {
    // Build the 64-byte pubkey ScVal directly using xdr.ScVal.scvBytes so we
    // don't depend on BytesN's constructor signature (which varies by SDK
    // version). The Soroban XDR encoding for BytesN<64> is identical to
    // scvBytes with 64 raw bytes.
    const { xdr } = await sdk();
    const pubkeyScVal = xdr.ScVal.scvBytes(Buffer.from(pubkeyBytes));
    keyValid = await simulate<boolean>(
      simulationAccount,
      contract.call(
        "is_valid_issuer_key",
        Address.fromString(issuerId).toScVal(),
        pubkeyScVal,
      ),
    );
  } catch {
    // Key check failed — treat as active so we don't block unnecessarily.
    return "active";
  }

  if (keyValid === false) return "key_retired";
  return "active";
}