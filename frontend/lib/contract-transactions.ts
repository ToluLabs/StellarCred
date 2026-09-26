"use client";

// Soroban transaction construction, signing, submission, and polling.
//
// Every on-chain write in the app flows through this module:
//   submitProof             — single credential proof
//   submitProofs            — atomic batch of up to MAX_BATCH_SIZE proofs
//   submitAggregateProof    — one circuit proof bundling N credentials
//
// Preflight simulations (no wallet signature required):
//   preflightSubmitProof    — simulate a single submit_proof
//   preflightSubmitProofs   — simulate a batch submit_proofs
//
// The shared private helpers `sendAndConfirm` and `runPreflight` handle the
// full build → sign → submit → poll and build → simulate lifecycles.
// `buildSubmitProofOp` / `buildSubmitProofsOp` are shared between the real
// submission and the preflight so the simulated and submitted bytes never
// drift apart.

import { Buffer } from "buffer";
import { RPC_URL, NETWORK_PASSPHRASE, CONTRACTS } from "./stellar";
import { signTx } from "./wallet";
import {
  PROOF_REGISTRY_ERRORS,
  type PreflightResult,
  evaluateSimulation,
} from "./contract-errors";

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

// ── Shared helpers ────────────────────────────────────────────────────────────

function isBadUnionSwitch(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("Bad union switch");
}

// ── Public types ──────────────────────────────────────────────────────────────

/** Parameters for a single proof within a batch or standalone submission. */
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

// ── Op builders (shared by submit and preflight) ──────────────────────────────

/**
 * Build the single-credential `submit_proof` operation. Shared by the real
 * {@link submitProof} (send + confirm) and the {@link preflightSubmitProof}
 * simulation so the simulated and submitted bytes never drift apart.
 */
function buildSubmitProofOp(
  contract: InstanceType<SDK["Contract"]>,
  o: {
    holder: string;
    issuerId: string;
    credentialType: string;
    proof: Uint8Array;
    publicInputs: Uint8Array;
    expiry: number;
    vkVersion?: number;
  },
): InstanceType<SDK["xdr"]["Operation"]> {
  const { Address, nativeToScVal, xdr } = sdkSync();
  return contract.call(
    "submit_proof",
    Address.fromString(o.holder).toScVal(),
    Address.fromString(o.issuerId).toScVal(),
    nativeToScVal(o.credentialType, { type: "symbol" }),
    xdr.ScVal.scvBytes(Buffer.from(o.proof)),
    xdr.ScVal.scvBytes(Buffer.from(o.publicInputs)),
    o.vkVersion != null
      ? nativeToScVal(o.vkVersion, { type: "u32" })
      : nativeToScVal(null, { type: "void" }),
    nativeToScVal(BigInt(o.expiry), { type: "u64" }),
  );
}

/**
 * Build the batch `submit_proofs` operation from a list of submissions.
 * Shared by the real {@link submitProofs} and the {@link preflightSubmitProofs}
 * simulation so the simulated and submitted bytes never drift apart.
 */
function buildSubmitProofsOp(
  contract: InstanceType<SDK["Contract"]>,
  holder: string,
  submissions: ProofSubmissionParams[],
  now: number,
): InstanceType<SDK["xdr"]["Operation"]> {
  const { Address, nativeToScVal, xdr } = sdkSync();

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
      u32s.push(val >>> 0); // convert to unsigned u32
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

  return contract.call(
    "submit_proofs",
    Address.fromString(holder).toScVal(),
    xdr.ScVal.scvVec(submissionVals),
  );
}

// ── Core tx lifecycle ─────────────────────────────────────────────────────────

/** Build, sign, submit, and poll a transaction to confirmed SUCCESS. */
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
  while (result.status === "NOT_FOUND" && Date.now() - start < 65_000) {
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

// ── Preflight simulation ──────────────────────────────────────────────────────

/**
 * Run a read-only Soroban simulation of a submit and map the outcome to a
 * {@link PreflightResult}: `ok: true` with an estimated fee when the tx would
 * succeed, or `ok: false` with a human-mapped {@link ContractError} when it
 * would revert — all before any wallet signature is requested.
 */
async function runPreflight(
  holder: string,
  buildOp: (contract: InstanceType<SDK["Contract"]>) => InstanceType<SDK["xdr"]["Operation"]>,
  timeoutSeconds = 60,
): Promise<PreflightResult> {
  if (!CONTRACTS.proofRegistry) {
    return {
      ok: false,
      error: {
        code: null,
        friendly:
          "ProofRegistry contract id not set. Deploy the contracts and fill NEXT_PUBLIC_PROOF_REGISTRY_ID.",
        raw: "NEXT_PUBLIC_PROOF_REGISTRY_ID missing",
      },
    };
  }

  const { Contract, TransactionBuilder, rpc, BASE_FEE } = await sdk();
  const srv = await getServer();

  const account = await srv.getAccount(holder);
  const contract = new Contract(CONTRACTS.proofRegistry);
  const op = buildOp(contract);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(timeoutSeconds)
    .build();

  const sim = await srv.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    const err =
      typeof sim.error === "string"
        ? sim.error
        : JSON.stringify(sim.error ?? "Transaction would fail");
    return evaluateSimulation({ success: false, error: err });
  }

  // Soroban success responses carry the minimum resource fee (in stroops);
  // older endpoints may omit it, in which case we report 0 rather than fail.
  const fee = Number((sim as { minResourceFee?: string | number }).minResourceFee ?? 0);
  return evaluateSimulation({ success: true, minResourceFee: Number.isFinite(fee) ? fee : 0 });
}

// ── Public preflight functions ────────────────────────────────────────────────

/**
 * Run a preflight simulation of a single `submit_proof`, mapping any
 * predictable failure to the ProofRegistry error table and estimating the fee,
 * **without** requesting a wallet signature. Call this before {@link submitProof}
 * to let the user see both the estimated fee and a human failure reason.
 */
export async function preflightSubmitProof(params: {
  holder: string;
  issuerId: string;
  credentialType: string;
  proof: Uint8Array;
  publicInputs: Uint8Array;
  ttlSecs: number;
  /** VK version. Omit or pass undefined to use latest. */
  vkVersion?: number;
}): Promise<PreflightResult> {
  const { holder, issuerId, credentialType, proof, publicInputs, ttlSecs, vkVersion } = params;
  const expiry = Math.floor(Date.now() / 1000) + ttlSecs;
  return runPreflight(holder, (contract) =>
    buildSubmitProofOp(contract, {
      holder,
      issuerId,
      credentialType,
      proof,
      publicInputs,
      expiry,
      vkVersion,
    }),
  );
}

/**
 * Run a preflight simulation of a batched `submit_proofs`, mapping any
 * predictable failure to the ProofRegistry error table and estimating the fee,
 * **without** requesting a wallet signature. Local invariants that the contract
 * enforces (empty batch, batch too large, duplicate type) are short-circuited
 * here as the corresponding contract error so the user sees a human reason
 * before anything is signed.
 */
export async function preflightSubmitProofs(params: {
  holder: string;
  submissions: ProofSubmissionParams[];
}): Promise<PreflightResult> {
  const { holder, submissions } = params;

  // Mirrors the contract-enforced invariants in submitProofs (the codes match
  // the ProofRegistry error enum: BatchTooLarge=7, BatchEmpty=8,
  // DuplicateCredentialType=9). Failing here costs nothing, whereas failing
  // on-chain costs a signature and a fee for a reverting transaction.
  if (submissions.length === 0) {
    return {
      ok: false,
      error: { code: 8, friendly: PROOF_REGISTRY_ERRORS[8], raw: "Batch is empty." },
    };
  }
  if (submissions.length > MAX_BATCH_SIZE) {
    return {
      ok: false,
      error: {
        code: 7,
        friendly: PROOF_REGISTRY_ERRORS[7],
        raw: `Batch has ${submissions.length} submissions (max ${MAX_BATCH_SIZE}).`,
      },
    };
  }
  const types = new Set<string>();
  for (const s of submissions) {
    if (types.has(s.credentialType)) {
      return {
        ok: false,
        error: {
          code: 9,
          friendly: PROOF_REGISTRY_ERRORS[9],
          raw: `Duplicate credential type: ${s.credentialType}.`,
        },
      };
    }
    types.add(s.credentialType);
  }

  const now = Math.floor(Date.now() / 1000);
  return runPreflight(
    holder,
    (contract) => buildSubmitProofsOp(contract, holder, submissions, now),
    90,
  );
}

// ── Public submission functions ───────────────────────────────────────────────

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
  return sendAndConfirm(
    holder,
    (contract) =>
      buildSubmitProofOp(contract, {
        holder,
        issuerId,
        credentialType,
        proof,
        publicInputs,
        expiry,
        vkVersion,
      }),
    "Submission",
  );
}

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

  const { Contract, TransactionBuilder, BASE_FEE } = await sdk();
  const srv = await getServer();

  const account = await srv.getAccount(holder);
  const contract = new Contract(CONTRACTS.proofRegistry);
  const now = Math.floor(Date.now() / 1000);
  const op = buildSubmitProofsOp(contract, holder, submissions, now);

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

  const start = Date.now();
  let result;
  try {
    result = await srv.getTransaction(sent.hash);
  } catch (e) {
    if (isBadUnionSwitch(e)) return sent.hash;
    throw e;
  }
  while (result.status === "NOT_FOUND" && Date.now() - start < 65_000) {
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
 * Submit an aggregate proof that bundles N credential proofs into a single
 * on-chain transaction. Accepts arrays of issuer IDs, credential types, and
 * per-credential TTLs (in seconds) so heterogeneous credentials can carry
 * different expiries in one submission — mirrors the contract's
 * `expiries: Vec<u64>` parameter on `submit_aggregate_proof`.
 */
export async function submitAggregateProof(params: {
  holder: string;
  issuerIds: string[];
  credentialTypes: string[];
  proof: Uint8Array;
  publicInputs: Uint8Array;
  /** One TTL (seconds from now) per credential, same order as credentialTypes. */
  ttlSecsPerCredential: number[];
}): Promise<string> {
  const { holder, issuerIds, credentialTypes, proof, publicInputs, ttlSecsPerCredential } = params;

  if (ttlSecsPerCredential.length !== credentialTypes.length) {
    throw new Error(
      `Expected ${credentialTypes.length} TTL values (one per credential), received ${ttlSecsPerCredential.length}.`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const expiries = ttlSecsPerCredential.map((ttl) => now + ttl);

  return sendAndConfirm(
    holder,
    (contract) => {
      const { Address, nativeToScVal, xdr } = sdkSync();
      const issuerScVec = xdr.ScVal.scvVec(
        issuerIds.map((id) => Address.fromString(id).toScVal()),
      );
      const typeScVec = xdr.ScVal.scvVec(
        credentialTypes.map((t) => nativeToScVal(t, { type: "symbol" })),
      );
      const expiryScVec = xdr.ScVal.scvVec(
        expiries.map((e) => nativeToScVal(BigInt(e), { type: "u64" })),
      );
      return contract.call(
        "submit_aggregate_proof",
        Address.fromString(holder).toScVal(),
        issuerScVec,
        typeScVec,
        xdr.ScVal.scvBytes(Buffer.from(proof)),
        xdr.ScVal.scvBytes(Buffer.from(publicInputs)),
        expiryScVec,
      );
    },
    "Aggregate submission",
  );
}
