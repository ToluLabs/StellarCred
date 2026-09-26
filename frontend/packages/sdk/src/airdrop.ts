// @stellarcred/sdk — verified-human-once claims (anti-Sybil distribution)
//
// Companion to the `human_airdrop` reference contract. It turns StellarCred's
// per-app nullifier primitive into two questions any airdrop, faucet, quota or
// governance contract needs answered before it distributes anything:
//
//   1. Is this wallet a verified human for my campaign's credential rule?
//   2. Has that human ALREADY claimed in this campaign — through *any* wallet?
//
// The nullifier that answers (2) is derived as
//
//     nullifier = sha256( identity_commitment || app_scope )
//
// `identity_commitment` is public-input field 0 of the ZK proof, recorded by
// the ProofRegistry at submission time. It is stable for a human across wallet
// addresses, so Sybil addresses sharing one credential collapse to a single
// nullifier. `app_scope` is per-campaign, so nullifiers cannot be correlated
// across campaigns.
//
// `deriveNullifier` below re-implements that derivation off-chain **exactly**;
// a shared test vector pins it to the contract
// (`contracts/human_airdrop/src/test.rs`).
//
// Quick start:
//
//   import { createHumanClaim } from "@stellarcred/sdk";
//
//   const drop = createHumanClaim({ contractId: process.env.HUMAN_AIRDROP_ID! });
//   const check = await drop.canClaim("drop1", wallet);
//   if (!check.eligible) return deny(check.reason); // e.g. "AlreadyClaimed"

// ---------------------------------------------------------------------------
// Nullifier derivation (pure, isomorphic)
// ---------------------------------------------------------------------------

const HEX = "0123456789abcdef";

/**
 * Realm-agnostic "is this a byte view?" — `instanceof Uint8Array` is false for
 * a typed array created in another realm (jsdom vs node, iframe vs page), and
 * both show up in practice, so brand-check instead.
 */
function asByteView(value: unknown): Uint8Array | null {
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function toBytes(input: string | Uint8Array, label: string): Uint8Array {
  const view = asByteView(input);
  if (view) return view;
  if (typeof input !== "string") {
    throw new TypeError(`${label} must be a hex string or Uint8Array`);
  }
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  if (/^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0 && hex.length > 0) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  throw new TypeError(`${label} must be an even-length hex string or Uint8Array`);
}

/** UTF-8 encode an app scope string (the contract stores the same raw bytes). */
export function scopeBytes(scope: string | Uint8Array): Uint8Array {
  return asByteView(scope) ?? new TextEncoder().encode(String(scope));
}

/** Lower-case hex, no `0x` prefix — the representation used everywhere here. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "WebCrypto (globalThis.crypto.subtle) is unavailable — required for nullifier derivation",
    );
  }
  const digest = await subtle.digest("SHA-256", bytes.slice() as unknown as BufferSource);
  return new Uint8Array(digest);
}

/**
 * Derive a per-app nullifier off-chain: `sha256(identity_commitment || scope)`.
 *
 * Byte-for-byte identical to `ProofRegistry::app_nullifier`, so a value derived
 * here can be compared against on-chain state (e.g. `isSpent`) without a
 * round-trip. `commitment` is the 32-byte identity commitment (hex or bytes)
 * returned by {@link HumanClaim.identityCommitment}.
 *
 * @returns lower-case hex of the 32-byte nullifier.
 */
export async function deriveNullifier(
  commitment: string | Uint8Array,
  scope: string | Uint8Array,
): Promise<string> {
  const commitmentBytes = toBytes(commitment, "commitment");
  if (commitmentBytes.length !== 32) {
    throw new TypeError("commitment must be exactly 32 bytes");
  }
  const scopeRaw = scopeBytes(scope);
  const preimage = new Uint8Array(commitmentBytes.length + scopeRaw.length);
  preimage.set(commitmentBytes, 0);
  preimage.set(scopeRaw, commitmentBytes.length);
  return toHex(await sha256(preimage));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors the contract's `Eligibility` enum, one-for-one. */
export const ELIGIBILITY = [
  "Eligible",
  "CampaignNotFound",
  "CampaignInactive",
  "CampaignNotStarted",
  "CampaignEnded",
  "NotVerifiedHuman",
  "AlreadyClaimed",
  "BudgetExhausted",
] as const;

export type Eligibility = (typeof ELIGIBILITY)[number];

/** Human-readable reason strings, safe to surface in a UI. */
export const ELIGIBILITY_REASONS: Record<Eligibility, string> = {
  Eligible: "Eligible to claim.",
  CampaignNotFound: "No such campaign.",
  CampaignInactive: "This campaign is paused.",
  CampaignNotStarted: "This campaign has not started yet.",
  CampaignEnded: "This campaign has ended.",
  NotVerifiedHuman: "No valid credential — get verified first.",
  AlreadyClaimed: "This human has already claimed in this campaign.",
  BudgetExhausted: "This campaign has run out of allocation.",
};

export interface Campaign {
  /** App scope (hex) mixed into every nullifier for this campaign. */
  scope: string;
  /** App scope decoded as UTF-8, when it is printable text. */
  scopeText: string | null;
  credentialType: string;
  minThreshold: number | null;
  trustedIssuers: string[] | null;
  amount: bigint;
  budget: bigint;
  distributed: bigint;
  /** Unique humans that have claimed. */
  claims: number;
  /** 0 = unlimited. */
  maxClaims: number;
  /** Unix seconds; `end === 0` means no end. */
  start: number;
  end: number;
  active: boolean;
}

/** A single contract argument, in a shape the reader can convert to ScVal. */
export type ContractArg =
  | { type: "symbol"; value: string }
  | { type: "address"; value: string }
  | { type: "bytes"; value: Uint8Array };

/**
 * Low-level read hook: invoke `method` on a contract and return the decoded
 * native result. The default implementation simulates the call over Soroban
 * RPC; tests (and exotic hosts) can inject their own.
 */
export type ContractReader = (
  contractId: string,
  method: string,
  args: ContractArg[],
) => Promise<unknown>;

export interface HumanClaimConfig {
  /** Deployed `human_airdrop` contract id. */
  contractId: string;
  /** Deployed `proof_registry` contract id — only needed by `identityCommitment`. */
  registryId?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  requestTimeoutMs?: number;
  /** Override the on-chain reader (used by tests). */
  reader?: ContractReader;
}

export interface ClaimCheck {
  eligible: boolean;
  reason: Eligibility;
  /** Human-readable form of `reason`. */
  message: string;
  /** The human's campaign-scoped nullifier, when they hold a valid credential. */
  nullifier: string | null;
}

// ---------------------------------------------------------------------------
// Default reader — Soroban RPC simulation
// ---------------------------------------------------------------------------

// A well-known, always-valid read-only source account. Simulation never
// submits anything, so this account does not need to exist or hold funds.
const READ_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function defaultReader(config: Required<Pick<HumanClaimConfig, "rpcUrl" | "networkPassphrase">>) {
  const reader: ContractReader = async (contractId, method, args) => {
    const sdk = await import("@stellar/stellar-sdk");
    const server = new sdk.rpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    const contract = new sdk.Contract(contractId);
    const scArgs = args.map((a) => {
      if (a.type === "symbol") return sdk.nativeToScVal(a.value, { type: "symbol" });
      if (a.type === "address") return sdk.Address.fromString(a.value).toScVal();
      return sdk.xdr.ScVal.scvBytes(Buffer.from(a.value));
    });
    const tx = new sdk.TransactionBuilder(new sdk.Account(READ_SOURCE, "0"), {
      fee: sdk.BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(contract.call(method, ...scArgs))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sdk.rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation of ${method} failed: ${sim.error}`);
    }
    const retval = sim.result?.retval;
    return retval === undefined ? null : sdk.scValToNative(retval);
  };
  return reader;
}

// ---------------------------------------------------------------------------
// Decoding helpers (exported for testability)
// ---------------------------------------------------------------------------

/** Normalise the many shapes a Soroban unit-variant enum can decode into. */
export function decodeEligibility(raw: unknown): Eligibility {
  let tag: unknown = raw;
  if (Array.isArray(tag)) tag = tag[0];
  if (tag && typeof tag === "object" && "tag" in (tag as Record<string, unknown>)) {
    tag = (tag as { tag: unknown }).tag;
  }
  const found = ELIGIBILITY.find((e) => e === tag);
  if (!found) throw new Error(`Unrecognised eligibility value: ${JSON.stringify(raw)}`);
  return found;
}

function bytesOf(value: unknown): Uint8Array | null {
  const view = asByteView(value);
  if (view) return view;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === "string") {
    try {
      return toBytes(value, "bytes");
    } catch {
      return null;
    }
  }
  return null;
}

function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // eslint-disable-next-line no-control-regex
    return /^[\x20-\x7e]*$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return 0;
}

function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value !== "") return BigInt(value);
  return 0n;
}

/** Decode the contract's `Campaign` struct into plain JS. */
export function decodeCampaign(raw: unknown): Campaign | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const scope = bytesOf(c.scope) ?? new Uint8Array();
  return {
    scope: toHex(scope),
    scopeText: utf8OrNull(scope),
    credentialType: String(c.credential_type ?? ""),
    minThreshold:
      c.min_threshold === undefined || c.min_threshold === null ? null : num(c.min_threshold),
    trustedIssuers: Array.isArray(c.trusted_issuers)
      ? (c.trusted_issuers as string[]).map(String)
      : null,
    amount: big(c.amount),
    budget: big(c.budget),
    distributed: big(c.distributed),
    claims: num(c.claims),
    maxClaims: num(c.max_claims),
    start: num(c.start),
    end: num(c.end),
    active: Boolean(c.active),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface HumanClaim {
  /** Campaign configuration and live counters, or `null` if it doesn't exist. */
  campaign(campaignId: string): Promise<Campaign | null>;
  /** The wallet's campaign-scoped nullifier (hex), or `null` if not a verified human. */
  nullifierFor(campaignId: string, wallet: string): Promise<string | null>;
  /** Has this nullifier already been consumed in this campaign? */
  isSpent(campaignId: string, nullifier: string | Uint8Array): Promise<boolean>;
  /** Has the human behind this wallet already claimed in this campaign? */
  hasClaimed(campaignId: string, wallet: string): Promise<boolean>;
  /** Raw eligibility code from the contract. */
  eligibility(campaignId: string, wallet: string): Promise<Eligibility>;
  /** One-call pre-flight: eligibility + reason + nullifier. */
  canClaim(campaignId: string, wallet: string): Promise<ClaimCheck>;
  /** Unique humans that have claimed. */
  claimsCount(campaignId: string): Promise<number>;
  /** The wallet's 32-byte identity commitment (hex). Requires `registryId`. */
  identityCommitment(wallet: string, credentialType: string): Promise<string | null>;
  /**
   * Derive the nullifier entirely off-chain from an identity commitment and a
   * campaign scope — no RPC. Same bytes as the contract.
   */
  deriveNullifier(
    commitment: string | Uint8Array,
    scope: string | Uint8Array,
  ): Promise<string>;
}

/**
 * Create a reader for a deployed `human_airdrop` contract.
 *
 * Every method is read-only (simulation): the SDK never signs or submits. To
 * actually claim, invoke `claim(caller, campaign_id)` with the user's wallet.
 */
export function createHumanClaim(config: HumanClaimConfig): HumanClaim {
  if (!config?.contractId) {
    throw new Error("createHumanClaim: `contractId` is required");
  }
  const rpcUrl = config.rpcUrl ?? "https://soroban-testnet.stellar.org";
  const networkPassphrase = config.networkPassphrase ?? "Test SDF Network ; September 2015";
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const read = config.reader ?? defaultReader({ rpcUrl, networkPassphrase });

  function call(contractId: string, method: string, args: ContractArg[]): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`RPC read timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    return Promise.race([
      Promise.resolve().then(() => read(contractId, method, args)),
      timeout,
    ]).finally(() => clearTimeout(timer)) as Promise<unknown>;
  }

  const drop = (method: string, args: ContractArg[]) => call(config.contractId, method, args);

  async function nullifierFor(campaignId: string, wallet: string): Promise<string | null> {
    const raw = await drop("nullifier_for", [
      { type: "symbol", value: campaignId },
      { type: "address", value: wallet },
    ]);
    if (raw === null || raw === undefined) return null;
    const bytes = bytesOf(raw);
    return bytes ? toHex(bytes) : null;
  }

  async function eligibility(campaignId: string, wallet: string): Promise<Eligibility> {
    return decodeEligibility(
      await drop("eligibility", [
        { type: "symbol", value: campaignId },
        { type: "address", value: wallet },
      ]),
    );
  }

  return {
    async campaign(campaignId) {
      return decodeCampaign(
        await drop("get_campaign", [{ type: "symbol", value: campaignId }]),
      );
    },

    nullifierFor,

    async isSpent(campaignId, nullifier) {
      const bytes = toBytes(nullifier, "nullifier");
      return Boolean(
        await drop("is_spent", [
          { type: "symbol", value: campaignId },
          { type: "bytes", value: bytes },
        ]),
      );
    },

    async hasClaimed(campaignId, wallet) {
      return Boolean(
        await drop("has_claimed", [
          { type: "symbol", value: campaignId },
          { type: "address", value: wallet },
        ]),
      );
    },

    eligibility,

    async canClaim(campaignId, wallet) {
      const [reason, nullifier] = await Promise.all([
        eligibility(campaignId, wallet),
        nullifierFor(campaignId, wallet).catch(() => null),
      ]);
      return {
        eligible: reason === "Eligible",
        reason,
        message: ELIGIBILITY_REASONS[reason],
        nullifier,
      };
    },

    async claimsCount(campaignId) {
      return num(await drop("claims_count", [{ type: "symbol", value: campaignId }]));
    },

    async identityCommitment(wallet, credentialType) {
      if (!config.registryId) {
        throw new Error(
          "identityCommitment() needs the ProofRegistry address — pass `registryId` to createHumanClaim()",
        );
      }
      const raw = await call(config.registryId, "identity_commitment", [
        { type: "address", value: wallet },
        { type: "symbol", value: credentialType },
      ]);
      if (raw === null || raw === undefined) return null;
      const bytes = bytesOf(raw);
      return bytes ? toHex(bytes) : null;
    },

    deriveNullifier,
  };
}
