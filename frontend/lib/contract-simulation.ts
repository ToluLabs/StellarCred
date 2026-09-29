"use client";

// Preflight simulation and read-only contract queries.
//
// These functions never mutate ledger state — they use simulateTransaction so
// they carry no fee and require no wallet signature. Kept separate from the
// transaction-building layer so callers can import just the read path without
// pulling in the write path.
//
// Degraded mode (Issue #634): a read that never produced an answer is
// `unknown`, not `false`. Both reads return a discriminated union so TypeScript
// refuses `result.valid` unless the caller has narrowed the status first —
// showing "not verified" when the truth is "cannot determine" is the failure
// mode this module exists to prevent. Every outcome is also reported to the
// app-wide RPC health store (lib/rpc-health.ts) so the UI can attribute the
// state to the network instead of to the credential.

import { RPC_URL, NETWORK_PASSPHRASE, CONTRACTS } from "./stellar";
import {
  classifyRpcError,
  isMissingAccountError,
  reportRpcHealthy,
  reportRpcIssue,
  type RpcIssue,
} from "./rpc-health";

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

/** Tri-state outcome of a ledger read. `unknown` is never a negative answer. */
export type ReadStatus = "verified" | "unverified" | "unknown";

/** Outcome of {@link checkClaim}. */
export type ClaimResult =
  | { status: "verified" | "unverified"; proved: true | false }
  | { status: "unknown"; proved?: undefined; issue: RpcIssue };

/** Outcome of {@link isVerified}. */
export type VerificationResult =
  | { status: "verified" | "unverified"; valid: boolean; verifiedAt: number; expiry: number; issue?: undefined }
  | { status: "unknown"; valid?: undefined; verifiedAt: 0; expiry: 0; issue: RpcIssue };

/** Reason a read could not be attempted at all. */
const NOT_CONFIGURED: RpcIssue = {
  kind: "not-configured",
  message: "This build has no ProofRegistry configured, so no claim status can be read.",
};

const unknownClaim = (issue: RpcIssue): ClaimResult => {
  reportRpcIssue(issue);
  return { status: "unknown", issue };
};

const unknownVerification = (issue: RpcIssue): VerificationResult => {
  reportRpcIssue(issue);
  return { status: "unknown", verifiedAt: 0, expiry: 0, issue };
};

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
 *
 * Returns `unknown` (with an `issue`) when the read produced no answer, so a
 * caller must distinguish "no proof" from "could not ask".
 */
export async function checkClaim(
  holder: string,
  credentialType: string,
  minThreshold?: number,
  trustedIssuers?: string[],
): Promise<ClaimResult> {
  if (!CONTRACTS.proofRegistry) return unknownClaim(NOT_CONFIGURED);

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

  try {
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
    if (rpc.Api.isSimulationError(sim) || !sim.result) {
      return unknownClaim(
        classifyRpcError(`The contract rejected the read: ${describeSimulationError(sim)}`),
      );
    }
    const proved = scValToNative(sim.result.retval) as boolean;
    reportRpcHealthy();
    return { status: proved ? "verified" : "unverified", proved };
  } catch (e) {
    // An address with no account on this network genuinely holds no proofs.
    // The node answered, so this is a negative result, not an outage.
    if (isMissingAccountError(e)) {
      reportRpcHealthy();
      return { status: "unverified", proved: false };
    }
    return unknownClaim(classifyRpcError(e));
  }
}

/**
 * Read-only check of whether `holder` has a currently-valid proof of `type`.
 *
 * `trustedIssuers`, if provided, restricts which issuer's proof is accepted —
 * see {@link checkClaim}. Omit to accept any registered issuer.
 *
 * Returns `unknown` (with an `issue`) when the read produced no answer; callers
 * that only read `result.valid` will not type-check against the unknown branch.
 */
export async function isVerified(
  holder: string,
  credentialType: string,
  trustedIssuers?: string[],
): Promise<VerificationResult> {
  if (!CONTRACTS.proofRegistry) return unknownVerification(NOT_CONFIGURED);

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

  try {
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
    if (rpc.Api.isSimulationError(sim) || !sim.result) {
      return unknownVerification(
        classifyRpcError(`The contract rejected the read: ${describeSimulationError(sim)}`),
      );
    }

    const [valid, verifiedAt, expiry] = scValToNative(sim.result.retval) as [
      boolean,
      bigint | number,
      bigint | number,
    ];
    reportRpcHealthy();
    return {
      status: valid ? "verified" : "unverified",
      valid,
      verifiedAt: Number(verifiedAt),
      expiry: Number(expiry),
    };
  } catch (e) {
    if (isMissingAccountError(e)) {
      reportRpcHealthy();
      return { status: "unverified", valid: false, verifiedAt: 0, expiry: 0 };
    }
    return unknownVerification(classifyRpcError(e));
  }
}

/** Best-effort text for a simulation error object, for the UI tooltip. */
function describeSimulationError(sim: unknown): string {
  if (sim && typeof sim === "object") {
    const s = sim as { status?: unknown; errorResultCodes?: unknown; statusCode?: unknown };
    const parts = [s.status, s.errorResultCodes, s.statusCode].filter(Boolean);
    if (parts.length) return parts.map(String).join(" ");
  }
  return "no result";
}
