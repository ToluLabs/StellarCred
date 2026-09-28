// Optional indexer-backed reads. Indexer responses are public chain data cached by
// an independent service; callers must choose the trust mode explicitly.

import type { RetryOptions } from "./claims";

export type IndexerReadSource = "indexer-cache" | "indexer-verify-against-chain";

export interface IndexerConfig {
  /** Base URL of the public StellarCred indexer, without a required path. */
  url: string;
  /** Optional API key when the indexer is configured with API_KEY protection. */
  apiKey?: string;
}

export interface IndexedClaim {
  id: number;
  wallet: string;
  credential_type: string;
  issuer: string;
  verified_at: number;
  expiry: number;
  ledger_sequence: number;
  threshold: number | null;
  revoked: number;
}

interface IndexedClaimsResponse {
  wallet: string;
  claims: IndexedClaim[];
}

function indexerUrl(config: IndexerConfig): string {
  return config.url.replace(/\/+$/, "");
}

function toNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Indexer returned invalid ${field}`);
  return number;
}

function normalizeClaim(raw: unknown): IndexedClaim {
  if (!raw || typeof raw !== "object") throw new Error("Indexer returned an invalid claim");
  const claim = raw as Record<string, unknown>;
  if (typeof claim.wallet !== "string" || typeof claim.credential_type !== "string") {
    throw new Error("Indexer returned an invalid claim");
  }
  return {
    id: toNumber(claim.id, "id"),
    wallet: claim.wallet,
    credential_type: claim.credential_type,
    issuer: typeof claim.issuer === "string" ? claim.issuer : "",
    verified_at: toNumber(claim.verified_at, "verified_at"),
    expiry: toNumber(claim.expiry, "expiry"),
    ledger_sequence: toNumber(claim.ledger_sequence, "ledger_sequence"),
    threshold: claim.threshold === null || claim.threshold === undefined
      ? null
      : toNumber(claim.threshold, "threshold"),
    revoked: toNumber(claim.revoked, "revoked"),
  };
}

export async function fetchIndexedClaims(
  config: IndexerConfig,
  wallet: string,
  opts: {
    requestTimeoutMs: number;
    retryOptions?: RetryOptions;
  },
): Promise<IndexedClaim[]> {
  if (typeof fetch !== "function") {
    throw new Error("Indexer reads require a runtime with fetch support");
  }

  const url = new URL("/claims", `${indexerUrl(config)}/`);
  url.searchParams.set("wallet", wallet);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const retries = opts.retryOptions?.retries ?? 0;
  const baseDelayMs = opts.retryOptions?.baseDelayMs ?? 250;
  const maxDelayMs = opts.retryOptions?.maxDelayMs ?? 2000;
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.requestTimeoutMs);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`Indexer request failed with HTTP ${response.status}`);
      const body = (await response.json()) as IndexedClaimsResponse;
      if (!body || !Array.isArray(body.claims)) throw new Error("Indexer returned an invalid response");
      return body.claims.map(normalizeClaim);
    } catch (error) {
      if (attempt >= retries) throw error;
      attempt++;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function indexedClaimForType(
  claims: readonly IndexedClaim[],
  claimType: string,
): IndexedClaim | null {
  // The indexer is ordered by ingestion and upserts the current record. Select
  // the newest matching row defensively in case an older deployment returns history.
  const matches = claims.filter((claim) => claim.credential_type === claimType);
  return matches.sort((a, b) =>
    b.ledger_sequence - a.ledger_sequence || b.id - a.id
  )[0] ?? null;
}
