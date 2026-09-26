"use client";

// Error taxonomy, fee estimation helpers, and simulation mapping for the
// StellarCred ProofRegistry contract.
//
// This is the single source of truth for contract error codes — shared with
// both the client-side interaction layer (contracts.ts) and any SDK-typed
// error helpers. Keep error messages here and import from this module
// everywhere else.

// ── Error table ───────────────────────────────────────────────────────────────

/**
 * Maps ProofRegistry on-chain error codes to human-readable messages.
 * Must stay in sync with the Rust contract's `Error` enum:
 *
 *   NotInitialized          = 1
 *   VerificationFailed      = 2
 *   NotAuthorized           = 3
 *   IssuerNotTrusted        = 4
 *   IssuerKeyMismatch       = 5
 *   ProofNotFound           = 6
 *   BatchTooLarge           = 7
 *   BatchEmpty              = 8
 *   DuplicateCredentialType = 9
 *   AggregateLayoutInvalid  = 10
 *   SubmissionsPaused       = 11
 *   InvalidExpiry           = 12
 */
export const PROOF_REGISTRY_ERRORS: Record<number, string> = {
  1: "Contracts not initialised — check that all contract IDs are set in the environment.",
  2: "Proof verification failed — the ZK proof is invalid or was generated against the wrong circuit VK.",
  3: "Not authorised — wallet signature missing or wrong account.",
  4: "Issuer not trusted — the issuer address isn't registered for this credential type.",
  5: "Issuer key mismatch — this credential was signed with a key that doesn't match what's registered on-chain. Re-issue the credential and try again.",
  6: "Proof not found — no on-chain proof exists for this holder and credential type.",
  7: "Batch too large — reduce the number of proofs and try again.",
  8: "Batch is empty — include at least one proof submission.",
  9: "Duplicate credential type — the batch contains two proofs for the same claim type. Remove the duplicate and try again.",
  10: "Aggregate proof layout invalid — the number of credentials or public inputs don't match the expected format. Re-generate the aggregate proof.",
  11: "Submissions paused — the protocol admin has temporarily halted new proof submissions. Try again later.",
  12: "Invalid expiry — the credential expiry is either in the past or too far in the future. Re-issue with a valid validity window.",
};

// ── ContractError ─────────────────────────────────────────────────────────────

/** Structured representation of a contract-layer error surfaced to the UI. */
export interface ContractError {
  friendly: string;
  code: number | null;
  raw: string;
}

/**
 * Normalises a raw contract error string into a {@link ContractError}.
 *
 * Handles:
 * - Numeric contract errors:  `Error(Contract, #N)` → looks up {@link PROOF_REGISTRY_ERRORS}
 * - Wallet auth failures:     `Error(Auth…)`        → friendly auth message
 * - Wasm VM errors:           `Error(WasmVm…)`      → friendly malformed-input message
 * - Anything else:            returned verbatim with `code: null`
 */
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
    return {
      code: null,
      friendly: "Wallet authorisation failed — approve the transaction in your wallet.",
      raw,
    };
  }
  if (raw.includes("Error(WasmVm")) {
    return {
      code: null,
      friendly: "Contract execution failed — the proof or inputs were malformed.",
      raw,
    };
  }
  return { code: null, friendly: raw, raw };
}

// ── Preflight / fee-estimation helpers (Issue #409) ───────────────────────────

/** Stellar uses 10^7 stroops per 1 lumen (XLM). */
export const STROOPS_PER_XLM = 1e7;

/**
 * Format a fee in stroops as a compact human string, e.g. `12345` →
 * `"0.0012345 XLM"`. `0`/negative values render as `"0 XLM"`.
 */
export function formatFeeXlm(stroops: number): string {
  if (!Number.isFinite(stroops) || stroops <= 0) return "0 XLM";
  const xlm = stroops / STROOPS_PER_XLM;
  const cleaned = xlm
    .toFixed(7)
    .replace(/\.?0+$/, ""); // strip trailing zeros (and the dot) for display
  return `${cleaned || "0"} XLM`;
}

export interface FeeEstimate {
  /** Estimated fee in stroops, from the simulation's minimum resource fee. */
  stroops: number;
  /** Human display string, e.g. "0.0012345 XLM". */
  display: string;
}

export type PreflightResult =
  | { ok: true; fee: FeeEstimate }
  | { ok: false; error: ContractError };

/**
 * Normalize the raw Soroban error string so {@link parseContractError} can map
 * it to the ProofRegistry error table. Contract errors sometimes arrive as
 * `Result(ContractError(N))` / `ContractError(Some(N))` rather than the
 * `Error(Contract, #N)` form the map keys on; fold those into the canonical
 * form while leaving already-canonical strings untouched.
 */
export function normalizeSimulationError(raw: string): string {
  if (!raw) return raw;
  if (raw.includes("Error(Contract,")) return raw;
  const m = raw.match(/ContractError\((?:Some\()?(\d+)/);
  if (m) return `Error(Contract, #${m[1]})`;
  return raw;
}

/**
 * Pure mapping from a Soroban simulation outcome to a {@link PreflightResult}.
 * Keeping this split from the network call lets the fee extraction and error
 * mapping be exercised in unit tests with plain-object fixtures.
 */
export function evaluateSimulation(outcome: {
  success: boolean;
  minResourceFee?: number;
  error?: string;
}): PreflightResult {
  if (!outcome.success) {
    return {
      ok: false,
      error: parseContractError(normalizeSimulationError(outcome.error ?? "")),
    };
  }
  const stroops =
    Number.isFinite(outcome.minResourceFee) && (outcome.minResourceFee as number) > 0
      ? Math.floor(outcome.minResourceFee as number)
      : 0;
  return { ok: true, fee: { stroops, display: formatFeeXlm(stroops) } };
}
