"use client";

// Real Soroban contract calls against the deployed StellarCred contracts.
//  - submitProof: builds, signs (via wallet), and submits a ProofRegistry
//    submit_proof transaction carrying a real UltraHonk proof.
//  - submitProofs: submits multiple proofs in a single atomic transaction
//    via ProofRegistry.submit_proofs.
//  - isVerified: read-only simulation of ProofRegistry.is_verified.
//
// @stellar/stellar-sdk is imported dynamically so it never runs during SSR.

import { Buffer } from "buffer";
import { RPC_URL, NETWORK_PASSPHRASE, CONTRACTS } from "./stellar";
import { signTx } from "./wallet";

type SDK = typeof import("@stellar/stellar-sdk");

let sdkPromise: Promise<SDK> | null = null;
let sdkModule: SDK | null = null;
function sdk(): Promise<SDK> {
  if (!sdkPromise) {
    sdkPromise = import("@stellar/stellar-sdk").then((m) => {
      sdkModule = m;
      return m;
    });
  }
  return sdkPromise;
}

/** Synchronously access the already-loaded SDK. Only valid after sdk() has resolved. */
function sdkSync(): SDK {
  if (!sdkModule) throw new Error("SDK not loaded — call await sdk() first");
  return sdkModule;
}

let server: InstanceType<SDK["rpc"]["Server"]> | null = null;
async function getServer() {
  if (!server) {
    const { rpc } = await sdk();
    server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });
  }
  return server;
}

const PROOF_REGISTRY_ERRORS: Record<number, string> = {
  1: "Contracts not initialised — check that all contract IDs are set in the environment.",
  2: "Proof verification failed — the ZK proof is invalid or was generated against the wrong circuit VK.",
  3: "Not authorised — wallet signature missing or wrong account.",
  4: "Issuer not trusted — the issuer address isn't registered for this credential type.",
  5: "Issuer key mismatch — this credential was signed with a key that doesn't match what's registered on-chain. Re-issue the credential and try again.",
  6: "Duplicate credential type — a proof for this claim type is already on-chain for this wallet. Revoke or wait for expiry before submitting again.",
  7: "Credential revoked — the issuer has revoked this credential. Re-issue through the verify flow.",
  8: "Credential expired — the on-chain proof has passed its validity window. Re-issue to get a fresh proof.",
};

export interface ContractError {
  friendly: string;
  code: number | null;
  raw: string;
}

export function parseContractError(raw: string): ContractError {
  const match = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (match) {
    const code = parseInt(match[1]);
    return {
      code,
      friendly: PROOF_REGISTRY_ERRORS[code] ?? `Contract error #${code}.`,
      raw,
    };
  }
  if (raw.includes("Error(Auth")) {
    return { code: null, friendly: "Wallet authorisation failed — approve the transaction in your wallet.", raw };
  }
  if (raw.includes("Error(WasmVm")) {
    return { code: null, friendly: "Contract execution failed — the proof or inputs were malformed.", raw };
  }
  return { code: null, friendly: raw, raw };
}

export interface VerificationStatus {
  valid: boolean;
  verifiedAt: number;
  expiry: number;
}

// ── Shared tx building, signing, submission, and polling ─────────────────────

function isBadUnionSwitch(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("Bad union switch");
}

/** Build, sign, submit, and poll a transaction. */
async function sendAndConfirm(
  holder: string,
  buildOp: (contract: InstanceType<SDK["Contract"]>) => InstanceType<SDK["xdr"]["Operation"]>,
  label: string,
): Promise<string> {
  if (!CONTRACTS.proofRegistry) {
    throw new Error(
      "ProofRegistry contract id not set. Deploy the contracts and fill NEXT_PUBLIC_PROOF_REGISTRY_ID.",
    );
  }

  const { Contract, TransactionBuilder, BASE_FEE } = await sdk();
  const srv = await getServer();

  const account = await srv.getAccount(holder);
  const contract = new Contract(CONTRACTS.proofRegistry);
  const op = buildOp(contract);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  const signedXdr = await signTx(prepared.toXDR(), holder);
  const sent = await srv.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE),
  );

  if (sent.status === "ERROR") {
    const errHex =
      sent.errorResult &&
      typeof (sent.errorResult as { toXDR?: (f: string) => string }).toXDR === "function"
        ? (sent.errorResult as { toXDR: (f: string) => string }).toXDR("hex")
        : String(sent.errorResult);
    throw new Error(`${label} rejected: ${errHex}`);
  }

  const start = Date.now();
  let result;
  try {
    result = await srv.getTransaction(sent.hash);
  } catch (e) {
    if (isBadUnionSwitch(e)) return sent.hash;
    throw e;
  }
  while (result.status === "NOT_FOUND" && Date.now() - start < 30_000) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      result = await srv.getTransaction(sent.hash);
    } catch (e) {
      if (isBadUnionSwitch(e)) return sent.hash;
      throw e;
    }
  }
  if (result.status !== "SUCCESS") {
    throw new Error(`Transaction ${sent.hash} did not succeed (${result.status}).`);
  }
  return sent.hash;
}

export interface ProofSubmissionParams {
  issuerId: string;
  credentialType: string;
  proof: Uint8Array;
  publicInputs: Uint8Array;
  /** Validity window in seconds from now. */
  ttlSecs: number;
  /** VK version. Omit or pass undefined to use latest. */
  vkVersion?: number;
}

/**
 * Mirrors `ProofRegistry::MAX_BATCH_SIZE`. Kept here so the UI can enforce the
 * same cap before it spends time generating proofs the contract would reject.
 */
export const MAX_BATCH_SIZE = 5;

/**
 * Submit multiple proofs in a single atomic transaction via
 * ProofRegistry.submit_proofs.
 *
 * All proofs are verified on-chain before anything is stored. If any one proof
 * fails, the entire call reverts. Max batch size is {@link MAX_BATCH_SIZE}
 * (enforced by the contract, and re-checked here).
 *
 * Returns the confirmed transaction hash.
 */
export async function submitProofs(params: {
  holder: string;
  submissions: ProofSubmissionParams[];
}): Promise<string> {
  const { holder, submissions } = params;

  // Both are contract-enforced; failing here costs the caller nothing, whereas
  // failing on-chain costs a signature and a fee for a transaction that reverts.
  if (submissions.length === 0) {
    throw new Error("Batch submission requires at least one proof.");
  }
  if (submissions.length > MAX_BATCH_SIZE) {
    throw new Error(
      `Batch submission accepts at most ${MAX_BATCH_SIZE} proofs, received ${submissions.length}.`,
    );
  }
  const types = new Set<string>();
  for (const s of submissions) {
    if (types.has(s.credentialType)) {
      // The registry stores one slot per (holder, credential_type), so a
      // duplicate type in one batch is rejected rather than overwritten.
      throw new Error(`Batch submission contains two ${s.credentialType} proofs.`);
    }
    types.add(s.credentialType);
  }

  if (!CONTRACTS.proofRegistry) {
    throw new Error(
      "ProofRegistry contract id not set. Deploy the contracts and fill NEXT_PUBLIC_PROOF_REGISTRY_ID.",
    );
  }

  const { Contract, TransactionBuilder, Address, nativeToScVal, xdr, BASE_FEE } =
    await sdk();
  const srv = await getServer();

  const account = await srv.getAccount(holder);
  const contract = new Contract(CONTRACTS.proofRegistry);
  const now = Math.floor(Date.now() / 1000);

  // Build each ProofSubmission as an XDR map (struct).
  const submissionVals = submissions.map((s) => {
    const expiry = now + s.ttlSecs;

    // Convert s.publicInputs (Uint8Array) to an array of u32 (big-endian).
    if (s.publicInputs.length % 4 !== 0) {
      throw new Error(
        `publicInputs for credential "${s.credentialType}" has length ${s.publicInputs.length}, which is not a multiple of 4 bytes.`,
      );
    }
    const u32s: number[] = [];
    for (let i = 0; i < s.publicInputs.length; i += 4) {
      const val =
        (s.publicInputs[i] << 24) |
        (s.publicInputs[i + 1] << 16) |
        (s.publicInputs[i + 2] << 8) |
        s.publicInputs[i + 3];
      u32s.push(val >>> 0); // Convert to unsigned u32
    }

    return xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("credential_type"),
        val: nativeToScVal(s.credentialType, { type: "symbol" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("expiry"),
        val: nativeToScVal(BigInt(expiry), { type: "u64" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("issuer_id"),
        val: Address.fromString(s.issuerId).toScVal(),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("proof"),
        val: xdr.ScVal.scvBytes(Buffer.from(s.proof)),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("public_inputs"),
        val: xdr.ScVal.scvVec(u32s.map((val) => xdr.ScVal.scvU32(val))),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("vk_version"),
        val:
          s.vkVersion != null
            ? nativeToScVal(s.vkVersion, { type: "u32" })
            : nativeToScVal(null, { type: "void" }),
      }),
    ]);
  });

  const op = contract.call(
    "submit_proofs",
    Address.fromString(holder).toScVal(),
    xdr.ScVal.scvVec(submissionVals),
  );

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(90)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  const signedXdr = await signTx(prepared.toXDR(), holder);
  const sent = await srv.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE),
  );

  if (sent.status === "ERROR") {
    const errHex =
      sent.errorResult &&
      typeof (sent.errorResult as { toXDR?: (f: string) => string }).toXDR === "function"
        ? (sent.errorResult as { toXDR: (f: string) => string }).toXDR("hex")
        : String(sent.errorResult);
    throw new Error(`Batch submission rejected: ${errHex}`);
  }

  function isBadUnionSwitch(e: unknown): boolean {
    return e instanceof Error && e.message.startsWith("Bad union switch");
  }

  const start = Date.now();
  let result;
  try {
    result = await srv.getTransaction(sent.hash);
  } catch (e) {
    if (isBadUnionSwitch(e)) return sent.hash;
    throw e;
  }
  while (result.status === "NOT_FOUND" && Date.now() - start < 30_000) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      result = await srv.getTransaction(sent.hash);
    } catch (e) {
      if (isBadUnionSwitch(e)) return sent.hash;
      throw e;
    }
  }
  if (result.status !== "SUCCESS") {
    throw new Error(`Batch transaction ${sent.hash} did not succeed (${result.status}).`);
  }
  return sent.hash;
}

/**
 * Submit a proof to the ProofRegistry. Returns the confirmed transaction hash.
 */
export async function submitProof(params: {
  holder: string;
  issuerId: string;
  credentialType: string;
  proof: Uint8Array;
  publicInputs: Uint8Array;
  ttlSecs: number;
  /** VK version. Omit or pass undefined to use latest. */
  vkVersion?: number;
}): Promise<string> {
  const { holder, issuerId, credentialType, proof, publicInputs, ttlSecs, vkVersion } = params;
  const expiry = Math.floor(Date.now() / 1000) + ttlSecs;

  return sendAndConfirm(holder, (contract) => {
    const { Address, nativeToScVal, xdr } = sdkSync();
    return contract.call(
      "submit_proof",
      Address.fromString(holder).toScVal(),
      Address.fromString(issuerId).toScVal(),
      nativeToScVal(credentialType, { type: "symbol" }),
      xdr.ScVal.scvBytes(Buffer.from(proof)),
      xdr.ScVal.scvBytes(Buffer.from(publicInputs)),
      vkVersion != null
        ? nativeToScVal(vkVersion, { type: "u32" })
        : nativeToScVal(null, { type: "void" }),
      nativeToScVal(BigInt(expiry), { type: "u64" }),
    );
  }, "Submission");
}

/**
 * Submit an aggregate proof that bundles N credential proofs into a single
 * on-chain transaction. Accepts arrays of issuer IDs and credential types for
 * extensibility to N≤5.
 */
export async function submitAggregateProof(params: {
  holder: string;
  issuerIds: string[];
  credentialTypes: string[];
  proof: Uint8Array;
  publicInputs: Uint8Array;
  ttlSecs: number;
}): Promise<string> {
  const { holder, issuerIds, credentialTypes, proof, publicInputs, ttlSecs } = params;
  const expiry = Math.floor(Date.now() / 1000) + ttlSecs;

  return sendAndConfirm(holder, (contract) => {
    const { Address, nativeToScVal, xdr } = sdkSync();
    // Build ScVec for issuer_ids and credential_types.
    const issuerScVec = xdr.ScVal.scvVec(
      issuerIds.map((id) => Address.fromString(id).toScVal()),
    );
    const typeScVec = xdr.ScVal.scvVec(
      credentialTypes.map((t) => nativeToScVal(t, { type: "symbol" })),
    );
    return contract.call(
      "submit_aggregate_proof",
      Address.fromString(holder).toScVal(),
      issuerScVec,
      typeScVec,
      xdr.ScVal.scvBytes(Buffer.from(proof)),
      xdr.ScVal.scvBytes(Buffer.from(publicInputs)),
      nativeToScVal(BigInt(expiry), { type: "u64" }),
    );
  }, "Aggregate submission");
}

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

  const { rpc, Contract, TransactionBuilder, Address, nativeToScVal, scValToNative, xdr, BASE_FEE } =
    await sdk();
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

  const { rpc, Contract, TransactionBuilder, Address, nativeToScVal, scValToNative, xdr, BASE_FEE } =
    await sdk();
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
