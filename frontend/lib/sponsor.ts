"use client";

/**
 * Sponsored (gasless) proof submission.
 *
 * The holder signs the inner transaction (authorising the proof) but the
 * sponsor account wraps it in a fee-bump transaction and pays the network
 * fee. The holder never needs native XLM.
 *
 * Flow:
 *   1. Holder builds + signs the submit_proof transaction (client-side).
 *   2. Holder POSTs the signed XDR to /api/sponsor with their wallet address.
 *   3. Server wraps it in a fee-bump with the sponsor account, submits it.
 *   4. Server returns the confirmed transaction hash.
 *
 * Rate limiting is enforced per IP and per wallet on the server.
 */

import { RPC_URL, NETWORK_PASSPHRASE, CONTRACTS, SPONSOR_ACCOUNT_ID } from "./stellar";
import { signTx } from "./wallet";

type SDK = typeof import("@stellar/stellar-sdk");

let sdkPromise: Promise<SDK> | null = null;
async function sdk(): Promise<SDK> {
  if (!sdkPromise) {
    sdkPromise = import("@stellar/stellar-sdk") as Promise<SDK>;
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SponsorResult {
  ok: boolean;
  txHash?: string;
  error?: string;
  /** When the sponsor's rate limit was hit. */
  retryAfterSeconds?: number;
}

// ── Build the holder's inner transaction ──────────────────────────────────────

/**
 * Build, prepare, and sign the proof submission transaction as the holder.
 * Returns the signed XDR ready for the sponsor relay.
 *
 * This is intentionally split from submitSponsoredProof so the holder can
 * sign at their own pace (Freighter popup) before sending to the relay.
 */
export async function buildSignedInnerXdr(params: {
  holder: string;
  issuerId: string;
  credentialType: string;
  proof: Uint8Array;
  publicInputs: Uint8Array;
  ttlSecs: number;
  vkVersion?: number;
}): Promise<string> {
  const { holder, issuerId, credentialType, proof, publicInputs, ttlSecs, vkVersion } = params;
  const expiry = Math.floor(Date.now() / 1000) + ttlSecs;

  const { Contract, TransactionBuilder, Address, nativeToScVal, xdr, BASE_FEE } = await sdk();
  const srv = await getServer();
  const account = await srv.getAccount(holder);
  const contract = new Contract(CONTRACTS.proofRegistry);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
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
      ),
    )
    .setTimeout(90)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  return signTx(prepared.toXDR(), holder);
}

/**
 * Build, prepare, and sign a batch proof submission transaction as the holder.
 * Returns the signed XDR for the sponsor relay.
 */
export async function buildSignedBatchInnerXdr(params: {
  holder: string;
  submissions: Array<{
    issuerId: string;
    credentialType: string;
    proof: Uint8Array;
    publicInputs: Uint8Array;
    ttlSecs: number;
    vkVersion?: number;
  }>;
}): Promise<string> {
  const { holder, submissions } = params;

  const { Contract, TransactionBuilder, Address, nativeToScVal, xdr, BASE_FEE } = await sdk();
  const srv = await getServer();
  const account = await srv.getAccount(holder);
  const contract = new Contract(CONTRACTS.proofRegistry);
  const now = Math.floor(Date.now() / 1000);

  const submissionVals = submissions.map((s) => {
    const expiry = now + s.ttlSecs;

    const u32s: number[] = [];
    for (let i = 0; i < s.publicInputs.length; i += 4) {
      const val =
        (s.publicInputs[i] << 24) |
        (s.publicInputs[i + 1] << 16) |
        (s.publicInputs[i + 2] << 8) |
        s.publicInputs[i + 3];
      u32s.push(val >>> 0);
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

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "submit_proofs",
        Address.fromString(holder).toScVal(),
        xdr.ScVal.scvVec(submissionVals),
      ),
    )
    .setTimeout(90)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  return signTx(prepared.toXDR(), holder);
}

// ── Submit via sponsor relay ──────────────────────────────────────────────────

/**
 * Send a signed XDR to the sponsor relay, which wraps it in a fee-bump
 * and submits to the network.
 */
async function submitViaRelay(
  signedXdr: string,
  holder: string,
): Promise<SponsorResult> {
  const res = await fetch("/api/sponsor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedXdr, holder }),
  });

  const body = await res.json();
  return body as SponsorResult;
}

/**
 * Submit a proof with gasless/sponsored fees.
 * Builds the transaction, signs it with the holder's wallet, then sends
 * it to the sponsor relay.
 */
export async function submitSponsoredProof(params: {
  holder: string;
  issuerId: string;
  credentialType: string;
  proof: Uint8Array;
  publicInputs: Uint8Array;
  ttlSecs: number;
  vkVersion?: number;
}): Promise<string> {
  if (!CONTRACTS.proofRegistry) {
    throw new Error("ProofRegistry contract id not set.");
  }
  if (!SPONSOR_ACCOUNT_ID) {
    throw new Error("Sponsor account not configured — set NEXT_PUBLIC_SPONSOR_ACCOUNT_ID.");
  }

  const signedXdr = await buildSignedInnerXdr(params);
  const result = await submitViaRelay(signedXdr, params.holder);

  if (!result.ok) {
    if (result.retryAfterSeconds) {
      throw new Error(`Rate limited — try again in ${result.retryAfterSeconds} seconds.`);
    }
    throw new Error(result.error ?? "Sponsored submission failed.");
  }

  return result.txHash!;
}

/**
 * Submit a batch proof with gasless/sponsored fees.
 */
export async function submitSponsoredBatchProof(params: {
  holder: string;
  submissions: Array<{
    issuerId: string;
    credentialType: string;
    proof: Uint8Array;
    publicInputs: Uint8Array;
    ttlSecs: number;
    vkVersion?: number;
  }>;
}): Promise<string> {
  if (!CONTRACTS.proofRegistry) {
    throw new Error("ProofRegistry contract id not set.");
  }
  if (!SPONSOR_ACCOUNT_ID) {
    throw new Error("Sponsor account not configured — set NEXT_PUBLIC_SPONSOR_ACCOUNT_ID.");
  }

  const signedXdr = await buildSignedBatchInnerXdr(params);
  const result = await submitViaRelay(signedXdr, params.holder);

  if (!result.ok) {
    if (result.retryAfterSeconds) {
      throw new Error(`Rate limited — try again in ${result.retryAfterSeconds} seconds.`);
    }
    throw new Error(result.error ?? "Sponsored batch submission failed.");
  }

  return result.txHash!;
}

// ── Availability check ────────────────────────────────────────────────────────

/** Whether the client-side sponsor configuration is present. */
export function isSponsorAvailable(): boolean {
  return Boolean(SPONSOR_ACCOUNT_ID);
}
