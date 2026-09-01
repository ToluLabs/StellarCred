// Read-only IssuerRegistry access via Soroban simulation — no signing, no
// `stellar` CLI dependency needed for reads. Mirrors the approach in
// frontend/lib/issuer-registry.ts (kept standalone here so the CLI has no
// dependency on the Next.js app), calling the contract through a raw
// `Contract` rather than a generated client binding, which can drift out of
// sync with the deployed contract (e.g. `get_issuers` predates it).

import {
  Address,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";

export interface IssuerMetadata {
  name?: string;
  url?: string;
  logo?: string;
}

export interface IssuerStatus {
  issuerId: string;
  /** secp256k1 credential-signing public key (x || y, 64 bytes), hex-encoded. */
  pubkeyHex: string | null;
  /** `null` when no `--credential-type` was requested. */
  validForType: boolean | null;
  metadata: IssuerMetadata | null;
}

async function simulate<T>(
  rpcUrl: string,
  networkPassphrase: string,
  simAccount: string,
  op: xdr.Operation,
): Promise<T | null> {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  const account = await server.getAccount(simAccount);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) return null;
  return scValToNative(sim.result.retval) as T;
}

export async function fetchIssuers(options: {
  rpcUrl: string;
  networkPassphrase: string;
  issuerRegistryId: string;
  simAccount: string;
}): Promise<string[]> {
  const contract = new Contract(options.issuerRegistryId);
  const ids = await simulate<string[]>(
    options.rpcUrl,
    options.networkPassphrase,
    options.simAccount,
    contract.call("get_issuers"),
  );
  return ids ?? [];
}

export async function fetchIssuerStatus(options: {
  rpcUrl: string;
  networkPassphrase: string;
  issuerRegistryId: string;
  simAccount: string;
  issuerId: string;
  credentialType?: string;
}): Promise<IssuerStatus> {
  const contract = new Contract(options.issuerRegistryId);
  const issuerAddress = new Address(options.issuerId).toScVal();
  const args = [options.rpcUrl, options.networkPassphrase, options.simAccount] as const;

  const pubkeyBuf = await simulate<Buffer>(
    ...args,
    contract.call("get_issuer_pubkey", issuerAddress),
  ).catch(() => null);

  const metadata = await simulate<IssuerMetadata | null>(
    ...args,
    contract.call("get_issuer_metadata", issuerAddress),
  ).catch(() => null);

  let validForType: boolean | null = null;
  if (options.credentialType) {
    validForType =
      (await simulate<boolean>(
        ...args,
        contract.call(
          "is_valid_issuer",
          issuerAddress,
          nativeToScVal(options.credentialType, { type: "symbol" }),
        ),
      ).catch(() => false)) ?? false;
  }

  return {
    issuerId: options.issuerId,
    pubkeyHex: pubkeyBuf ? Buffer.from(pubkeyBuf).toString("hex") : null,
    validForType,
    metadata: metadata ?? null,
  };
}
