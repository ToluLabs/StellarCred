"use client";

// Preflight simulation and read-only contract queries.
//
// These functions never mutate ledger state — they use simulateTransaction so
// they carry no fee and require no wallet signature. Kept separate from the
// transaction-building layer so callers can import just the read path without
// pulling in the write path.

import { RPC_URL, NETWORK_PASSPHRASE, CONTRACTS } from "./stellar";

type SDK = typeof import("@stellar/stellar-sdk");

let sdkPromise: Promise<SDK> | null = null;
let _sdkModule: SDK | null = null;
function sdk(): Promise<SDK> {
  if (!sdkPromise) {
    sdkPromise = import("@stellar/stellar-sdk").then((m) => {
      _sdkModule = m;
      return m;
    });
  }
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

// ── Public types ──────────────────────────────────────────────────────────────

/** Shape of the on-chain verification record returned by {@link isVerified}. */
export interface VerificationStatus {
  valid: boolean;
  verifiedAt: number;
  expiry: number;
}

// ── Read-only queries ─────────────────────────────────────────────────────────

/**
 * Like isVerified but also enforces a minimum threshold for parameterised
 * credential types (age, income, funds). Calls ProofRegistry.check_claim which
 * stores the proved threshold and checks stored >= minThreshold server-side.
 * For kyc / jurisdiction pass minThreshold = undefined.
 *
 * `trustedIssuers`, if provided, restricts which issuer's proof is accepted —
 * the stored proof's issuer must be one of these addresses. Omit to accept
 * any registered issuer (unchanged default behaviour).
 */
export async function checkClaim(
  holder: string,
  credentialType: string,
  minThreshold?: number,
  trustedIssuers?: string[],
): Promise<boolean> {
  if (!CONTRACTS.proofRegistry) return false;

  const {
    rpc,
    Contract,
    TransactionBuilder,
    Address,
    nativeToScVal,
    scValToNative,
    xdr,
    BASE_FEE,
  } = await sdk();
  const srv = await getServer();

  const account = await srv.getAccount(holder);
  const contract = new Contract(CONTRACTS.proofRegistry);
  const op = contract.call(
    "check_claim",
    Address.fromString(holder).toScVal(),
    nativeToScVal(credentialType, { type: "symbol" }),
    minThreshold !== undefined
      ? nativeToScVal(BigInt(minThreshold), { type: "u64" })
      : nativeToScVal(null, { type: "void" }),
    trustedIssuers !== undefined
      ? xdr.ScVal.scvVec(trustedIssuers.map((a) => Address.fromString(a).toScVal()))
      : nativeToScVal(null, { type: "void" }),
  );
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await srv.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) return false;
  return scValToNative(sim.result.retval) as boolean;
}

/**
 * Read-only check of whether `holder` has a currently-valid proof of `type`.
 *
 * `trustedIssuers`, if provided, restricts which issuer's proof is accepted —
 * see {@link checkClaim}. Omit to accept any registered issuer.
 */
export async function isVerified(
  holder: string,
  credentialType: string,
  trustedIssuers?: string[],
): Promise<VerificationStatus> {
  const empty: VerificationStatus = { valid: false, verifiedAt: 0, expiry: 0 };
  if (!CONTRACTS.proofRegistry) return empty;

  const {
    rpc,
    Contract,
    TransactionBuilder,
    Address,
    nativeToScVal,
    scValToNative,
    xdr,
    BASE_FEE,
  } = await sdk();
  const srv = await getServer();

  const account = await srv.getAccount(holder);
  const contract = new Contract(CONTRACTS.proofRegistry);
  const op = contract.call(
    "is_verified",
    Address.fromString(holder).toScVal(),
    nativeToScVal(credentialType, { type: "symbol" }),
    trustedIssuers !== undefined
      ? xdr.ScVal.scvVec(trustedIssuers.map((a) => Address.fromString(a).toScVal()))
      : nativeToScVal(null, { type: "void" }),
  );
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const sim = await srv.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) return empty;

  const [valid, verifiedAt, expiry] = scValToNative(sim.result.retval) as [
    boolean,
    bigint | number,
    bigint | number,
  ];
  return { valid, verifiedAt: Number(verifiedAt), expiry: Number(expiry) };
}
