// @stellarcred/sdk
//
// A tiny, zero-dependency* read-only client for protocols integrating
// StellarCred. The only thing a protocol trusts is the on-chain
// ProofRegistry — there is no API key, no backend, and no personal data
// handling. `hasClaim` is the primary integration call.
//
// *Requires @stellar/stellar-sdk as a peer dependency.
//
// Quick start (Next.js / Vite / Node.js):
//
//   import StellarCred from "@stellarcred/sdk";
//
//   // Option A: configure explicitly at startup (recommended for servers)
//   StellarCred.configure({
//     registryId: process.env.PROOF_REGISTRY_ID,
//     rpcUrl: "https://soroban-testnet.stellar.org",
//   });
//
//   // Option B: set env vars instead (STELLARCRED_REGISTRY_ID, etc.)
//   //           — works in both Node.js and Next.js (NEXT_PUBLIC_* prefix)
//
//   const ok = await StellarCred.hasClaim(walletAddress, "kyc");

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

function env(key: string, nextPublicKey?: string): string {
  if (typeof process === "undefined") return "";
  return (
    (process.env as Record<string, string | undefined>)[key] ??
    (nextPublicKey
      ? ((process.env as Record<string, string | undefined>)[nextPublicKey] ?? "")
      : "")
  );
}

let _config = {
  registryId: env("STELLARCRED_REGISTRY_ID", "NEXT_PUBLIC_PROOF_REGISTRY_ID"),
  rpcUrl: env("STELLARCRED_RPC_URL", "NEXT_PUBLIC_RPC_URL") || "https://soroban-testnet.stellar.org",
  networkPassphrase:
    env("STELLARCRED_NETWORK_PASSPHRASE", "NEXT_PUBLIC_NETWORK_PASSPHRASE") ||
    "Test SDF Network ; September 2015",
  baseUrl: env("STELLARCRED_BASE_URL", "NEXT_PUBLIC_STELLARCRED_BASE_URL") || "https://stellarcred.xyz",
};

/**
 * Override SDK defaults at runtime. Call this once at app startup before any
 * `hasClaim` / `getClaims` calls. Each key is optional — omitted keys keep
 * their env-var-derived or default values.
 */
export function configure(opts: {
  registryId?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  baseUrl?: string;
}): void {
  _config = { ..._config, ...opts };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The credential types StellarCred supports. Matches the contract Symbols. */
export const CLAIM_TYPES = ["kyc", "age", "income", "jurisdiction", "funds", "accreditation"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export interface Claim {
  /** Credential type — one of CLAIM_TYPES. */
  type: string;
  /** Unix timestamp (seconds) when the proof was submitted on-chain. */
  verifiedAt: number;
  /** Unix timestamp (seconds) when the on-chain record expires. */
  expiry: number;
}

// ---------------------------------------------------------------------------
// Low-level read: ProofRegistry.is_verified via simulation
// ---------------------------------------------------------------------------

type StellarSDK = typeof import("@stellar/stellar-sdk");
let _sdk: Promise<StellarSDK> | null = null;
function getSdk(): Promise<StellarSDK> {
  if (!_sdk) _sdk = import("@stellar/stellar-sdk");
  return _sdk;
}

async function simulate<T>(wallet: string, op: unknown): Promise<T | null> {
  const { registryId, rpcUrl, networkPassphrase } = _config;
  if (!registryId) return null;

  const { rpc, TransactionBuilder, BASE_FEE, scValToNative } = await getSdk();
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

  let account;
  try {
    account = await server.getAccount(wallet);
  } catch {
    return null;
  }

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .addOperation(op as any)
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) return null;
  return scValToNative(sim.result.retval) as T;
}

async function readIsVerified(
  wallet: string,
  claimType: string,
): Promise<{ valid: boolean; verifiedAt: number; expiry: number } | null> {
  const { registryId } = _config;
  if (!registryId) return null;

  const { Contract, Address, nativeToScVal } = await getSdk();
  const contract = new Contract(registryId);
  const op = contract.call(
    "is_verified",
    Address.fromString(wallet).toScVal(),
    nativeToScVal(claimType, { type: "symbol" }),
  );

  const result = await simulate<[boolean, bigint | number, bigint | number]>(wallet, op);
  if (!result) return null;
  const [valid, verifiedAt, expiry] = result;
  return { valid, verifiedAt: Number(verifiedAt), expiry: Number(expiry) };
}

async function readCheckClaim(
  wallet: string,
  claimType: string,
  minThreshold: number,
): Promise<boolean> {
  const { registryId } = _config;
  if (!registryId) return false;

  const { Contract, Address, nativeToScVal } = await getSdk();
  const contract = new Contract(registryId);
  const op = contract.call(
    "check_claim",
    Address.fromString(wallet).toScVal(),
    nativeToScVal(claimType, { type: "symbol" }),
    nativeToScVal(BigInt(minThreshold), { type: "u64" }),
  );

  return (await simulate<boolean>(wallet, op)) ?? false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `wallet` has a currently-valid, unexpired proof of
 * `claimType` in the StellarCred ProofRegistry.
 *
 * For parameterised claim types (age, income, funds), pass `minThreshold` to
 * enforce that the proof was generated with at least that threshold — e.g. a
 * proof for "balance ≥ 200,000" satisfies `minThreshold: 50000`, but a proof
 * for "balance ≥ 10,000" does not. The check is performed on-chain and is
 * fully trustless.
 *
 * @example
 * // Binary claim — no threshold needed
 * const ok = await hasClaim("G1ABC…", "kyc");
 *
 * @example
 * // Funds gate — require balance ≥ $50,000
 * const ok = await hasClaim("G1ABC…", "funds", { minThreshold: 50000 });
 *
 * @example
 * // Age gate — require age ≥ 21
 * const ok = await hasClaim("G1ABC…", "age", { minThreshold: 21 });
 */
export async function hasClaim(
  wallet: string,
  claimType: string,
  opts?: { minThreshold?: number },
): Promise<boolean> {
  if (opts?.minThreshold !== undefined) {
    return readCheckClaim(wallet, claimType, opts.minThreshold);
  }
  const r = await readIsVerified(wallet, claimType);
  return !!r && r.valid;
}

/**
 * Returns every active claim a wallet has proven, across all known credential
 * types. Useful for profile pages and protocol dashboards.
 */
export async function getClaims(wallet: string): Promise<Claim[]> {
  const results = await Promise.all(
    CLAIM_TYPES.map(async (t) => {
      const r = await readIsVerified(wallet, t);
      return r && r.valid ? { type: t, verifiedAt: r.verifiedAt, expiry: r.expiry } : null;
    }),
  );
  return results.filter((x): x is NonNullable<typeof x> => x !== null);
}

/**
 * Build a StellarCred verification URL to redirect users to. After the user
 * verifies, StellarCred sends them back to `returnUrl` with `sc_verified=true`
 * and `sc_wallet=<address>` appended as query params.
 *
 * Pass `claimParams` to customize thresholds for parameterised claims:
 *
 * @example
 * // Require age ≥ 21
 * buildVerifyUrl({ returnUrl: "/deposit", claim: "age", claimParams: { threshold_years: "21" } })
 *
 * @example
 * // Require balance > $50,000
 * buildVerifyUrl({ returnUrl: "/vault", claim: "funds", claimParams: { threshold: "50000" } })
 *
 * @example
 * // Restrict specific countries
 * buildVerifyUrl({ returnUrl: "/app", claim: "jurisdiction", claimParams: { restricted: ["840","364"] } })
 */
export function buildVerifyUrl(options: {
  returnUrl: string;
  claim: string;
  /** Override the StellarCred base URL (defaults to config or https://stellarcred.xyz). */
  baseUrl?: string;
  claimParams?: {
    /** For "age" claims: minimum age in years (default "18"). */
    threshold_years?: string;
    /** For "income" / "funds" claims: minimum value in whole units (default varies). */
    threshold?: string;
    /** For "jurisdiction" claims: ISO 3166-1 numeric codes to block (default []). */
    restricted?: string | string[];
  };
}): string {
  const base = options.baseUrl ?? _config.baseUrl;
  const url = new URL("/verify", base);
  url.searchParams.set("return_url", options.returnUrl);
  url.searchParams.set("claim", options.claim);
  if (options.claimParams) {
    const { threshold_years, threshold, restricted } = options.claimParams;
    if (threshold_years) url.searchParams.set("threshold_years", threshold_years);
    if (threshold) url.searchParams.set("threshold", threshold);
    if (restricted) {
      url.searchParams.set("restricted", Array.isArray(restricted) ? restricted.join(",") : restricted);
    }
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Namespace export (StellarCred.hasClaim / StellarCred.getClaims / etc.)
// ---------------------------------------------------------------------------

export const StellarCred = { configure, hasClaim, getClaims, buildVerifyUrl, CLAIM_TYPES };
export default StellarCred;
