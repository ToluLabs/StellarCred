"use client";

import {
  ContractError as SdkContractError,
  PROOF_REGISTRY_ERROR_MESSAGES,
  classifyVerificationError,
  type VerificationErrorCategory,
} from "../packages/sdk/src/errors";

export const PROOF_REGISTRY_ERRORS: Record<number, string> = PROOF_REGISTRY_ERROR_MESSAGES;

export interface ContractError {
  friendly: string;
  code: number | null;
  /** Diagnostic identifier only; never contains exception or credential data. */
  raw: string;
  category: VerificationErrorCategory;
  retryable: boolean;
  diagnosticCode: string | number;
}

export function parseContractError(raw: unknown): ContractError {
  const normalized = classifyVerificationError(raw);
  const contract = SdkContractError.fromRaw(raw);
  return {
    friendly: contract?.friendlyMessage ?? normalized.message,
    code: contract?.code ?? (typeof normalized.code === "number" ? normalized.code : null),
    raw: String(normalized.code),
    category: normalized.category,
    retryable: normalized.retryable,
    diagnosticCode: normalized.code,
  };
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
  const cleaned = xlm.toFixed(7).replace(/\.?0+$/, ""); // strip trailing zeros (and the dot) for display
  return `${cleaned || "0"} XLM`;
}

export interface FeeEstimate {
  /** Estimated fee in stroops, from the simulation's minimum resource fee. */
  stroops: number;
  /** Human display string, e.g. "0.0012345 XLM". */
  display: string;
}

export type PreflightResult = { ok: true; fee: FeeEstimate } | { ok: false; error: ContractError };

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
