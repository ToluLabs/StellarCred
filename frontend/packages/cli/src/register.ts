/**
 * `stellarcred issuer register`: builds an IssuerRegistry.register_issuer
 * transaction and, only with --send, signs it with the admin key from the
 * environment and submits it.
 *
 * Signing never happens anywhere but the process running the CLI, and the key
 * is only ever read from STELLARCRED_ADMIN_SECRET — never from argv (shell
 * history, CI logs) and never from a NEXT_PUBLIC_* variable.
 */
import { submitTransaction } from "@stellarcred/sdk";
import type { CliConfig, Env } from "./config";

type StellarSDK = typeof import("@stellar/stellar-sdk");

export const SECRET_ENV = "STELLARCRED_ADMIN_SECRET";
const SECRET_SEED = /^S[A-Z2-7]{55}$/;
const SYMBOL = /^[A-Za-z0-9_]{1,32}$/;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A Stellar secret seed passed on the command line is refused outright. */
export function assertNoSecretsInArgs(argv: readonly string[]): void {
  if (argv.some((arg) => arg.split("=").some((part) => SECRET_SEED.test(part.trim())))) {
    throw new UsageError(
      `Refusing to read a secret key from the command line (it would end up in shell history and CI logs). Set ${SECRET_ENV} instead.`,
    );
  }
}

/** A secret seed in a NEXT_PUBLIC_* variable would ship to browsers. */
export function assertNoPublicSecrets(env: Env): void {
  const leaked = Object.entries(env).find(
    ([key, value]) => key.startsWith("NEXT_PUBLIC_") && value && SECRET_SEED.test(value.trim()),
  );
  if (leaked) {
    throw new UsageError(
      `${leaked[0]} holds a Stellar secret key. NEXT_PUBLIC_* variables are bundled into the browser; move it to ${SECRET_ENV} and rotate it.`,
    );
  }
}

export interface RegisterInput {
  issuerId: string;
  pubkeyHex: string;
  credentialTypes: string[];
  /** Public key of the admin account that signs (required without --send). */
  source?: string;
  send: boolean;
}

export interface RegisterResult {
  network: string;
  issuerRegistryId: string;
  source: string;
  /** Prepared transaction (base64). Unsigned unless sent. */
  xdr: string;
  signed: boolean;
  hash?: string;
  status?: string;
}

/** Minimal surface of rpc.Server used here — swapped for a fake in tests. */
export interface RegisterRpc {
  getAccount(
    address: string,
  ): Promise<{ accountId(): string; sequenceNumber(): string; incrementSequenceNumber(): void }>;
  prepareTransaction(
    tx: unknown,
  ): Promise<{ toXDR(): string; sign(...keypairs: unknown[]): void; hash(): Buffer }>;
  sendTransaction(tx: unknown): Promise<{ status: string; hash: string; errorResult?: unknown }>;
  getTransaction(hash: string): Promise<{ status: string }>;
}

export function validateRegisterInput(input: RegisterInput, sdk: StellarSDK): void {
  if (
    !sdk.StrKey.isValidEd25519PublicKey(input.issuerId) &&
    !sdk.StrKey.isValidContract(input.issuerId)
  ) {
    throw new UsageError(`Invalid issuer address "${input.issuerId}".`);
  }
  if (!/^[0-9a-fA-F]{128}$/.test(input.pubkeyHex.replace(/^0x/, ""))) {
    throw new UsageError(
      "--pubkey must be the issuer's secp256k1 public key as 128 hex characters (x || y, 64 bytes).",
    );
  }
  if (input.credentialTypes.length === 0)
    throw new UsageError("--types needs at least one credential type, e.g. --types kyc,age.");
  const bad = input.credentialTypes.find((t) => !SYMBOL.test(t));
  if (bad)
    throw new UsageError(
      `Invalid credential type "${bad}" (letters, digits and _ only, at most 32).`,
    );
  if (input.source && !sdk.StrKey.isValidEd25519PublicKey(input.source)) {
    throw new UsageError(`Invalid --source account "${input.source}".`);
  }
}

export async function registerIssuer(
  input: RegisterInput,
  config: CliConfig,
  env: Env,
  deps: { sdk?: StellarSDK; rpc?: RegisterRpc; pollIntervalMs?: number; maxPolls?: number } = {},
): Promise<RegisterResult> {
  const sdk = deps.sdk ?? (await import("@stellar/stellar-sdk"));
  validateRegisterInput(input, sdk);
  if (!config.issuerRegistryId) {
    throw new UsageError(
      "No IssuerRegistry id for this network: pass --issuer-registry-id or set STELLARCRED_ISSUER_REGISTRY_ID.",
    );
  }
  assertNoPublicSecrets(env);

  let keypair: InstanceType<StellarSDK["Keypair"]> | undefined;
  if (input.send) {
    const secret = env[SECRET_ENV]?.trim();
    if (!secret)
      throw new UsageError(`--send signs with the admin key in ${SECRET_ENV}, which is not set.`);
    try {
      keypair = sdk.Keypair.fromSecret(secret);
    } catch {
      throw new UsageError(`${SECRET_ENV} is not a valid Stellar secret key.`);
    }
    if (input.source && input.source !== keypair.publicKey()) {
      throw new UsageError(
        `--source ${input.source} does not match the account of ${SECRET_ENV} (${keypair.publicKey()}).`,
      );
    }
  }
  const source = keypair?.publicKey() ?? input.source;
  if (!source) {
    throw new UsageError(
      `Pass --source <admin public key> to build the transaction, or set ${SECRET_ENV} and use --send.`,
    );
  }

  const rpc: RegisterRpc =
    deps.rpc ??
    (new sdk.rpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    }) as unknown as RegisterRpc);

  const account = await rpc.getAccount(source);
  const op = new sdk.Contract(config.issuerRegistryId).call(
    "register_issuer",
    sdk.Address.fromString(input.issuerId).toScVal(),
    sdk.xdr.ScVal.scvBytes(Buffer.from(input.pubkeyHex.replace(/^0x/, ""), "hex")),
    sdk.nativeToScVal(input.credentialTypes.map((t) => sdk.nativeToScVal(t, { type: "symbol" }))),
  );
  const tx = new sdk.TransactionBuilder(account as never, {
    fee: sdk.BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(300)
    .build();
  // Simulates register_issuer (so an unauthorised source or a key change that
  // needs rotate_issuer_key fails here, before anything is signed) and adds
  // the Soroban footprint and resource fee.
  const prepared = await rpc.prepareTransaction(tx);

  const result: RegisterResult = {
    network: config.network,
    issuerRegistryId: config.issuerRegistryId,
    source,
    xdr: prepared.toXDR(),
    signed: false,
  };
  if (!input.send || !keypair) return result;

  prepared.sign(keypair);
  result.signed = true;
  result.xdr = prepared.toXDR();
  const sent = await submitTransaction(async () => {
    const res = await rpc.sendTransaction(prepared);
    if (res.status === "ERROR")
      throw new Error(
        `sendTransaction rejected the transaction: ${JSON.stringify(res.errorResult ?? res.status)}`,
      );
    return res;
  });
  result.hash = sent.hash;

  const interval = deps.pollIntervalMs ?? 1500;
  for (let i = 0; i < (deps.maxPolls ?? 40); i += 1) {
    const status = (await rpc.getTransaction(sent.hash)).status;
    if (status !== "NOT_FOUND") {
      result.status = status;
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  result.status = "PENDING";
  return result;
}
