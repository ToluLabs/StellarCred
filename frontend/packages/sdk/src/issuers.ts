// @stellarcred/sdk — read-only IssuerRegistry access.
//
// Protocols and ops tooling (the `stellarcred` CLI) use these to see which
// issuers are registered, what they may attest, and whether one is currently
// valid for a credential type. Like the claim reads, everything here is a
// Soroban *simulation*: nothing is signed or submitted, and no account is
// needed. Writes (register / revoke / rotate) are admin-only and live outside
// the SDK.

import { ConfigError, getConfig, InvalidIssuerError, withRetry } from "./claims";
import { RpcError } from "./errors";

/**
 * The all-zero ed25519 key: the same placeholder the generated contract clients
 * simulate from. Simulation needs no real, funded account.
 */
const SIMULATION_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
/** IssuerRegistry caps `get_issuers_page` at 20. */
const PAGE_SIZE = 20;

export interface IssuerMetadataRecord {
  name?: string;
  url?: string;
  logo?: string;
}

export interface IssuerRecord {
  /** Stellar address the issuer is registered under (G… or C…). */
  id: string;
  revoked: boolean;
  /** Credential types this issuer is trusted to attest. */
  credentialTypes: string[];
  /** Current secp256k1 signing key, x || y, as 128 hex characters. */
  pubkeyHex: string;
  /** Optional on-chain metadata (set via `set_issuer_metadata`). */
  metadata?: IssuerMetadataRecord;
}

export interface IssuerReadOptions {
  requestTimeoutMs?: number;
  /** Throw instead of returning an empty/null result on config or RPC errors. */
  throwOnError?: boolean;
}

export interface ListIssuersOptions extends IssuerReadOptions {
  /** Include revoked issuers. Default false. */
  includeRevoked?: boolean;
  /** Also read each issuer's optional metadata. Default true. */
  withMetadata?: boolean;
}

type StellarSDK = typeof import("@stellar/stellar-sdk");
let _sdk: Promise<StellarSDK> | null = null;
const sdk = () => (_sdk ??= import("@stellar/stellar-sdk"));

/** Test hook: forget the cached stellar-sdk module. */
export function resetIssuerClientForTesting(): void {
  _sdk = null;
}

function registryId(throwOnError: boolean | undefined): string | null {
  const id = getConfig().issuerRegistryId;
  if (!id) {
    if (throwOnError) {
      throw new ConfigError(
        "StellarCred is not configured: missing issuerRegistryId " +
          "(set STELLARCRED_ISSUER_REGISTRY_ID or call configure({ issuerRegistryId }))",
      );
    }
    return null;
  }
  return id;
}

/** Simulate one read-only IssuerRegistry call and decode its return value. */
async function simulate<T>(
  method: string,
  args: unknown[],
  opts: IssuerReadOptions,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const id = registryId(opts.throwOnError);
  if (!id) return { ok: false, error: "issuerRegistryId is not configured" };
  const { rpcUrl, networkPassphrase, requestTimeoutMs } = getConfig();
  const { rpc, Account, Contract, TransactionBuilder, BASE_FEE, scValToNative } = await sdk();
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  const tx = new TransactionBuilder(new Account(SIMULATION_ACCOUNT, "0"), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addOperation(new Contract(id).call(method, ...(args as any[])))
    .setTimeout(30)
    .build();

  const timeoutMs = opts.requestTimeoutMs ?? requestTimeoutMs;
  const sim = await withRetry(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        server.simulateTransaction(tx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RpcError(`RPC read timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
  if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error };
  if (!sim.result) return { ok: false, error: "simulation returned no result" };
  return { ok: true, value: scValToNative(sim.result.retval) as T };
}

async function addressArg(issuerId: string) {
  const { Address } = await sdk();
  try {
    return Address.fromString(issuerId.trim()).toScVal();
  } catch {
    throw new InvalidIssuerError(`Invalid issuer address: "${issuerId}"`);
  }
}

const toHex = (bytes: Uint8Array | Buffer) =>
  Array.from(bytes as Uint8Array, (b) => b.toString(16).padStart(2, "0")).join("");

function metadataOf(
  raw: Record<string, unknown> | null | undefined,
): IssuerMetadataRecord | undefined {
  if (!raw) return undefined;
  const pick = (k: string) =>
    typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : undefined;
  const meta = { name: pick("name"), url: pick("url"), logo: pick("logo") };
  return meta.name || meta.url || meta.logo ? meta : undefined;
}

/**
 * The on-chain record for one issuer, or `null` when it is not registered.
 * Revoked issuers are returned with `revoked: true`.
 */
export async function getIssuer(
  issuerId: string,
  opts: IssuerReadOptions & { withMetadata?: boolean } = {},
): Promise<IssuerRecord | null> {
  const arg = await addressArg(issuerId);
  try {
    const record = await simulate<{
      pubkey: Uint8Array;
      credential_types: string[];
      revoked: boolean;
    }>("get_issuer", [arg], opts);
    if (!record.ok) {
      // IssuerRegistry panics with IssuerNotFound (#2) for unknown issuers.
      if (/Error\(Contract, #2\)|IssuerNotFound/.test(record.error)) return null;
      if (opts.throwOnError && record.error !== "issuerRegistryId is not configured") {
        throw new RpcError(`get_issuer failed: ${record.error}`);
      }
      return null;
    }
    let metadata: IssuerMetadataRecord | undefined;
    if (opts.withMetadata !== false) {
      const meta = await simulate<Record<string, unknown> | null>(
        "get_issuer_metadata",
        [arg],
        opts,
      );
      metadata = meta.ok ? metadataOf(meta.value) : undefined;
    }
    return {
      id: issuerId.trim(),
      revoked: record.value.revoked,
      credentialTypes: record.value.credential_types.map(String),
      pubkeyHex: toHex(record.value.pubkey),
      ...(metadata ? { metadata } : {}),
    };
  } catch (err) {
    if (opts.throwOnError)
      throw err instanceof RpcError || err instanceof ConfigError
        ? err
        : new RpcError("get_issuer failed", { cause: err });
    return null;
  }
}

/** Every registered issuer address, paging through `get_issuers_page`. */
export async function listIssuerIds(opts: IssuerReadOptions = {}): Promise<string[]> {
  try {
    const count = await simulate<number>("issuer_count", [], opts);
    if (!count.ok) {
      // Older deployments without paging: fall back to the full list.
      const all = await simulate<string[]>("get_issuers", [], opts);
      if (!all.ok) {
        if (opts.throwOnError && all.error !== "issuerRegistryId is not configured") {
          throw new RpcError(`get_issuers failed: ${all.error}`);
        }
        return [];
      }
      return all.value.map(String);
    }
    const { nativeToScVal } = await sdk();
    const ids: string[] = [];
    for (let start = 0; start < Number(count.value); start += PAGE_SIZE) {
      const page = await simulate<string[]>(
        "get_issuers_page",
        [nativeToScVal(start, { type: "u32" }), nativeToScVal(PAGE_SIZE, { type: "u32" })],
        opts,
      );
      if (!page.ok) throw new RpcError(`get_issuers_page failed: ${page.error}`);
      ids.push(...page.value.map(String));
    }
    return ids;
  } catch (err) {
    if (opts.throwOnError) throw err;
    return [];
  }
}

/** Registered issuers with their records (active only unless `includeRevoked`). */
export async function listIssuers(opts: ListIssuersOptions = {}): Promise<IssuerRecord[]> {
  const ids = await listIssuerIds(opts);
  const records: IssuerRecord[] = [];
  for (const id of ids) {
    const record = await getIssuer(id, opts);
    if (record && (opts.includeRevoked || !record.revoked)) records.push(record);
  }
  return records;
}

/** `is_valid_issuer`: registered, not revoked, and trusted for `credentialType`. */
export async function isValidIssuer(
  issuerId: string,
  credentialType: string,
  opts: IssuerReadOptions = {},
): Promise<boolean> {
  const arg = await addressArg(issuerId);
  const { nativeToScVal } = await sdk();
  try {
    const res = await simulate<boolean>(
      "is_valid_issuer",
      [arg, nativeToScVal(credentialType, { type: "symbol" })],
      opts,
    );
    if (!res.ok) {
      if (opts.throwOnError && res.error !== "issuerRegistryId is not configured") {
        throw new RpcError(`is_valid_issuer failed: ${res.error}`);
      }
      return false;
    }
    return res.value === true;
  } catch (err) {
    if (opts.throwOnError) throw err;
    return false;
  }
}
