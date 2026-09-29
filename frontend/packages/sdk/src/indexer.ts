// @stellarcred/sdk — optional indexer read path (issue #613)
//
// Transport and evaluation logic for reading claim data from a StellarCred
// indexer instead of simulating against ProofRegistry.
//
// TRUST MODEL: the indexer is an off-chain cache of public chain data run by
// whoever operates it. It is NOT part of the trust-minimised path — the only
// thing a protocol needs to trust is ProofRegistry. Nothing in this module may
// be the sole basis for a security decision. See the SDK README §Indexer fast
// path.
//
// This module is deliberately dependency-free and imports nothing from
// `claims.ts`, keeping the module graph acyclic. Retry/timeout wrapping is
// applied by the caller.

/**
 * The raw wire shape returned by the indexer's claim-bearing endpoints
 * (`GET /claims`, `GET /recent`). Mirrors `SerializedClaim` in
 * `services/indexer/src/api.ts` — field names are snake_case because that is
 * what crosses the wire, and renaming them here would only hide the mapping.
 */
export interface IndexerClaimRow {
  id: number;
  wallet: string;
  credential_type: string;
  /**
   * Issuer address, or the empty string when the on-chain record had no issuer
   * (the column is `NOT NULL DEFAULT ''`). An empty string is the indexer's
   * encoding of the contract's `Option<Address>::None`, and must be treated the
   * same way when a trusted-issuer filter is applied.
   */
  issuer: string;
  /** Unix seconds. */
  verified_at: number;
  /** Unix seconds. */
  expiry: number;
  ledger_sequence: number;
  threshold: number | null;
  /**
   * `0` or `1`, not a boolean — the indexer normalises both DB backends onto
   * this shape. Treat any non-zero value as revoked.
   */
  revoked: number;
}

/** Response envelope of `GET /claims?wallet=…`. */
interface ClaimsResponse {
  wallet: string;
  claims: IndexerClaimRow[];
}

/**
 * Error thrown when an indexer request fails or returns a malformed body.
 * Follows the {@link RpcError} convention of carrying the underlying `cause`.
 */
export class IndexerError extends Error {
  cause?: unknown;
  /** HTTP status code when the indexer responded with an error status. */
  status?: number;

  constructor(
    message = "StellarCred indexer request failed",
    options?: { cause?: unknown; status?: number },
  ) {
    super(message);
    this.name = "IndexerError";
    this.cause = options?.cause;
    this.status = options?.status;
  }
}

export interface IndexerRequestOptions {
  /** Base URL of the indexer, e.g. `https://indexer.example.com`. */
  indexerUrl: string;
  /**
   * Optional API key. Only some deployments gate `/claims` behind one. Sent as
   * `Authorization: Bearer` rather than `X-API-Key` because the indexer's CORS
   * policy does not allow `X-API-Key` through a browser preflight.
   */
  apiKey?: string;
}

/**
 * Fetches every claim row the indexer holds for `wallet`, including revoked
 * ones — validity is decided by {@link evaluateClaimRow}, not by the server.
 *
 * Performs exactly one request; retry and timeout are the caller's job so this
 * module stays free of `claims.ts` imports.
 */
export async function fetchWalletClaims(
  wallet: string,
  opts: IndexerRequestOptions,
): Promise<IndexerClaimRow[]> {
  const base = opts.indexerUrl.replace(/\/+$/, "");
  const url = `${base}/claims?${new URLSearchParams({ wallet }).toString()}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, { headers, method: "GET" });
  } catch (err) {
    throw new IndexerError(`Indexer request to ${base}/claims failed`, {
      cause: err,
    });
  }

  if (!response.ok) {
    throw new IndexerError(
      `Indexer responded ${response.status} for ${base}/claims`,
      { status: response.status },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new IndexerError("Indexer response was not valid JSON", {
      cause: err,
      status: response.status,
    });
  }

  const claims = (body as ClaimsResponse | null)?.claims;
  if (!Array.isArray(claims)) {
    throw new IndexerError(
      "Indexer response was missing a `claims` array",
      { status: response.status },
    );
  }

  return claims;
}

/**
 * Indexer equivalent of the contract's private `issuer_is_trusted`
 * (`contracts/proof_registry/src/lib.rs:916`).
 *
 * - No filter → any issuer is accepted.
 * - Filter present → the row must carry a non-empty issuer that appears in the
 *   list. A row with an empty issuer is rejected, matching the contract's
 *   `Option<Address>::None => false` branch for un-migrated legacy records.
 */
export function issuerIsTrusted(
  issuer: string,
  trustedIssuers?: readonly string[],
): boolean {
  if (trustedIssuers === undefined) return true;
  if (issuer === "") return false;
  return trustedIssuers.includes(issuer);
}

export interface EvaluateClaimOptions {
  trustedIssuers?: readonly string[];
  minThreshold?: number;
  /** Unix seconds to compare `expiry` against. */
  nowSeconds: number;
}

/**
 * Recomputes claim validity from a raw indexer row, reproducing the contract's
 * `is_verified` / `check_claim` predicates exactly:
 *
 *   valid = !revoked && expiry > now && issuer_is_trusted(...)
 *   && (minThreshold === undefined || (row.threshold ?? 0) >= minThreshold)
 *
 * DIVERGENCE FROM CHAIN: the contract compares `expiry` against
 * `env.ledger().timestamp()`; this compares against the caller's wall clock.
 * Clock skew between the two is the main source of disagreement near an expiry
 * boundary, and is one reason indexer reads must not gate access on their own.
 */
export function evaluateClaimRow(
  row: IndexerClaimRow,
  opts: EvaluateClaimOptions,
): boolean {
  if (row.revoked !== 0) return false;
  if (!(row.expiry > opts.nowSeconds)) return false;
  if (!issuerIsTrusted(row.issuer, opts.trustedIssuers)) return false;
  if (opts.minThreshold !== undefined) {
    const threshold = row.threshold ?? 0;
    if (!(threshold >= opts.minThreshold)) return false;
  }
  return true;
}

/**
 * Picks the row for `claimType` out of a wallet's claim set. The indexer
 * enforces a unique `(wallet, credential_type)` constraint, so there is at most
 * one; the defensive scan keeps a duplicated row from silently picking an
 * arbitrary winner.
 */
export function findClaimRow(
  rows: readonly IndexerClaimRow[],
  claimType: string,
): IndexerClaimRow | undefined {
  return rows.find((row) => row.credential_type === claimType);
}
