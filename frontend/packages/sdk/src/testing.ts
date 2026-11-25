/**
 * @stellarcred/sdk/testing
 *
 * Test doubles for integrators who want to unit-test a StellarCred
 * integration in CI without a Soroban RPC, a deployed ProofRegistry, a Noir
 * toolchain, or a browser wallet extension.
 *
 * - {@link MockWalletProvider}: a SEP-43 shaped wallet backed by a real
 *   Ed25519 keypair. Signatures it produces pass `verifyWalletSignature` and
 *   `verifyWalletClaim`, and transactions it signs carry a real signature.
 * - {@link CredentialFactory}: builds credential JSON that passes
 *   `validateCredential`, signed with a real secp256k1 issuer key over the
 *   commitment, the way `@stellarcred/issuer` signs.
 * - {@link MockProofRegistry}: an in-memory ProofRegistry holding simulated
 *   proofs, with the contract's own `is_verified` / `check_claim` /
 *   `get_record` semantics (expiry, revocation, trusted issuers, thresholds).
 *   {@link installMockRegistry} routes every SDK claim read (`hasClaim`,
 *   `getClaims`, `checkClaimStatus`, `verifyWalletClaim`, ...) to it.
 *
 * Never import this module from production code. Mock credentials are not
 * provable: the commitment is a random field element, not the Poseidon2 hash
 * of `value` and `salt`, so a real prover rejects it.
 *
 * @example
 * ```ts
 * import { hasClaim } from "@stellarcred/sdk";
 * import {
 *   MockWalletProvider,
 *   CredentialFactory,
 *   installMockRegistry,
 *   uninstallMockRegistry,
 * } from "@stellarcred/sdk/testing";
 *
 * const wallet = MockWalletProvider.random();
 * const registry = installMockRegistry();
 * const credential = new CredentialFactory().create({ type: "kyc", holder: wallet.address });
 * registry.prove(credential);
 *
 * expect(await hasClaim(wallet.address, "kyc")).toBe(true);
 * uninstallMockRegistry();
 * ```
 */

import { Buffer } from "buffer";
import { Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { __setProofRegistryClientForTesting, type ProofRegistryReader } from "./claims";
import type { WalletChallenge } from "./challenge";
import {
  CREDENTIAL_TYPES,
  type CredentialClaimParams,
  type CredentialJson,
  type CredentialType,
} from "./validateCredential";

// ---------------------------------------------------------------------------
// Randomness and byte helpers
// ---------------------------------------------------------------------------

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("@stellarcred/sdk/testing needs globalThis.crypto.getRandomValues");
  }
  c.getRandomValues(out);
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

function bigIntToBytes(v: bigint, length = 32): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A random BN254-safe field element (31 bytes), `0x`-prefixed like the issuer emits. */
function randomField(): string {
  return "0x" + toHex(randomBytes(31));
}

// ---------------------------------------------------------------------------
// Minimal secp256k1 ECDSA (test-only; not constant time)
// ---------------------------------------------------------------------------

const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP_G: Point = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};

type Point = { x: bigint; y: bigint } | null;

const mod = (a: bigint, m: bigint): bigint => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

function invert(a: bigint, m: bigint): bigint {
  let [lo, hi] = [mod(a, m), m];
  let [x0, x1] = [1n, 0n];
  while (lo > 1n) {
    const q = hi / lo;
    [lo, hi] = [hi - q * lo, lo];
    [x0, x1] = [x1 - q * x0, x0];
  }
  return mod(x0, m);
}

function pointAdd(a: Point, b: Point): Point {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y, SECP_P) === 0n) return null;
    const l = mod(3n * a.x * a.x * invert(2n * a.y, SECP_P), SECP_P);
    const x = mod(l * l - 2n * a.x, SECP_P);
    return { x, y: mod(l * (a.x - x) - a.y, SECP_P) };
  }
  const l = mod((b.y - a.y) * invert(b.x - a.x, SECP_P), SECP_P);
  const x = mod(l * l - a.x - b.x, SECP_P);
  return { x, y: mod(l * (a.x - x) - a.y, SECP_P) };
}

function pointMul(k: bigint, p: Point): Point {
  let result: Point = null;
  let addend = p;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

function randomScalar(): bigint {
  for (;;) {
    const k = bytesToBigInt(randomBytes(32));
    if (k > 0n && k < SECP_N) return k;
  }
}

function secpPublicKey(priv: bigint): { x: number[]; y: number[] } {
  const p = pointMul(priv, SECP_G);
  if (!p) throw new Error("invalid secp256k1 private key");
  return { x: Array.from(bigIntToBytes(p.x)), y: Array.from(bigIntToBytes(p.y)) };
}

/** Compact (r || s), low-s, over the raw 32-byte digest (no pre-hash). */
function secpSign(digest: Uint8Array, priv: bigint): number[] {
  const z = bytesToBigInt(digest);
  for (;;) {
    const k = randomScalar();
    const R = pointMul(k, SECP_G);
    if (!R) continue;
    const r = mod(R.x, SECP_N);
    if (r === 0n) continue;
    let s = mod(invert(k, SECP_N) * (z + r * priv), SECP_N);
    if (s === 0n) continue;
    if (s > SECP_N / 2n) s = SECP_N - s;
    return [...bigIntToBytes(r), ...bigIntToBytes(s)];
  }
}

function secpVerify(digest: Uint8Array, sig: number[], pubX: number[], pubY: number[]): boolean {
  if (sig.length !== 64 || pubX.length !== 32 || pubY.length !== 32) return false;
  const r = bytesToBigInt(Uint8Array.from(sig.slice(0, 32)));
  const s = bytesToBigInt(Uint8Array.from(sig.slice(32)));
  if (r <= 0n || r >= SECP_N || s <= 0n || s >= SECP_N) return false;
  const Q: Point = {
    x: bytesToBigInt(Uint8Array.from(pubX)),
    y: bytesToBigInt(Uint8Array.from(pubY)),
  };
  if (mod(Q.y * Q.y - (Q.x * Q.x * Q.x + 7n), SECP_P) !== 0n) return false;
  const z = bytesToBigInt(digest);
  const w = invert(s, SECP_N);
  const X = pointAdd(pointMul(mod(z * w, SECP_N), SECP_G), pointMul(mod(r * w, SECP_N), Q));
  return !!X && mod(X.x, SECP_N) === r;
}

/** The 32-byte big-endian digest the issuer signs for a commitment. */
function commitmentDigest(commitment: string): Uint8Array {
  return bigIntToBytes(mod(BigInt(commitment), 1n << 256n));
}

// ---------------------------------------------------------------------------
// MockWalletProvider
// ---------------------------------------------------------------------------

/** Options shared by every {@link MockWalletProvider} signing call (SEP-43). */
export interface MockSignOptions {
  networkPassphrase?: string;
  /** If set, must match the wallet's address, like a real wallet enforces. */
  address?: string;
}

export interface MockWalletProviderOptions {
  /** Stellar secret seed (`S...`). A random keypair is used when omitted. */
  secret?: string;
  /** Network passphrase used by `signTransaction` when the call does not pass one. */
  networkPassphrase?: string;
  /**
   * Make every request fail as if the user dismissed the wallet prompt. `true`
   * uses a default message; a string sets it. Change later with
   * {@link MockWalletProvider.rejectRequests}.
   */
  reject?: boolean | string;
}

/** One recorded wallet request, for assertions. */
export interface MockWalletCall {
  method: "getAddress" | "signMessage" | "signTransaction";
  args: unknown[];
}

/** Thrown by a {@link MockWalletProvider} that is set to reject requests. */
export class MockWalletRejectedError extends Error {
  /** Matches the SEP-43 / Freighter "user rejected" code. */
  readonly code = -4;
  constructor(message: string) {
    super(message);
    this.name = "MockWalletRejectedError";
  }
}

/**
 * An in-process wallet with the SEP-43 surface (`getAddress`, `signMessage`,
 * `signTransaction`) that Stellar Wallets Kit modules expose, backed by a real
 * Ed25519 keypair. Use it wherever your integration takes a wallet.
 *
 * `signMessage` signs the UTF-8 bytes of the message directly, which is what
 * `verifyWalletSignature` and `verifyWalletClaim` check.
 */
export class MockWalletProvider {
  readonly keypair: Keypair;
  readonly networkPassphrase: string;
  /** Every request made to this wallet, oldest first. */
  readonly calls: MockWalletCall[] = [];
  private rejection: string | null = null;

  constructor(options: MockWalletProviderOptions = {}) {
    this.keypair = options.secret ? Keypair.fromSecret(options.secret) : Keypair.random();
    this.networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
    if (options.reject) this.rejectRequests(options.reject);
  }

  /** A wallet with a fresh random keypair. */
  static random(options: Omit<MockWalletProviderOptions, "secret"> = {}): MockWalletProvider {
    return new MockWalletProvider(options);
  }

  /** The wallet's public key (`G...`). */
  get address(): string {
    return this.keypair.publicKey();
  }

  /** Make later requests fail (or succeed again with `false`). */
  rejectRequests(reject: boolean | string = true): void {
    this.rejection =
      reject === false ? null : typeof reject === "string" ? reject : "User declined the request";
  }

  async getAddress(): Promise<{ address: string }> {
    this.record("getAddress", []);
    return { address: this.address };
  }

  async signMessage(
    message: string,
    opts: MockSignOptions = {},
  ): Promise<{ signedMessage: string; signerAddress: string }> {
    this.record("signMessage", [message, opts]);
    this.checkAddress(opts.address);
    const signature = this.keypair.sign(Buffer.from(message, "utf8"));
    return {
      signedMessage: Buffer.from(signature).toString("base64"),
      signerAddress: this.address,
    };
  }

  /** Signs `challenge.message` and returns the base64 signature `verifyWalletClaim` expects. */
  async signChallenge(challenge: Pick<WalletChallenge, "message">): Promise<string> {
    const { signedMessage } = await this.signMessage(challenge.message);
    return signedMessage;
  }

  async signTransaction(
    xdr: string,
    opts: MockSignOptions = {},
  ): Promise<{ signedTxXdr: string; signerAddress: string }> {
    this.record("signTransaction", [xdr, opts]);
    this.checkAddress(opts.address);
    const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase ?? this.networkPassphrase);
    tx.sign(this.keypair);
    return { signedTxXdr: tx.toXDR(), signerAddress: this.address };
  }

  private record(method: MockWalletCall["method"], args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.rejection) throw new MockWalletRejectedError(this.rejection);
  }

  private checkAddress(address: string | undefined): void {
    if (address !== undefined && address !== this.address) {
      throw new Error(`MockWalletProvider cannot sign for ${address}; it holds ${this.address}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CredentialFactory
// ---------------------------------------------------------------------------

export interface CredentialFactoryOptions {
  /** 64-hex-char secp256k1 issuer key. Random when omitted. */
  issuerPrivateKey?: string;
  /** Issuer address recorded on credentials and simulated proofs. Random `G...` when omitted. */
  issuerId?: string;
  /** Display name of the issuer. Defaults to "StellarCred Test Issuer". */
  issuerName?: string;
  /** Clock in milliseconds, for deterministic `issuedAt`. Defaults to `Date.now`. */
  now?: () => number;
}

export interface CreateCredentialOptions {
  type?: CredentialType;
  /** Holder wallet address. Random `G...` when omitted. */
  holder?: string;
  value?: string;
  salt?: string;
  /** Field element to sign. Random when omitted. */
  commitment?: string;
  /** Duration string, e.g. "90 days". Defaults to "365 days". */
  expiry?: string;
  /** Unix seconds. Defaults to the factory clock. */
  issuedAt?: number;
  claimParams?: CredentialClaimParams;
  /** Tenure in years for `employment` credentials. Defaults to "5". */
  seniority?: string;
  title?: string;
  claim?: string;
}

const TITLES: Record<CredentialType, string> = {
  kyc: "KYC Complete",
  age: "Age Verified",
  income: "Accredited (Income)",
  jurisdiction: "Jurisdiction Eligible",
  funds: "Proof of Funds",
  accreditation: "Accredited Investor (Net Worth)",
  employment: "Employed",
};

function defaultClaimLabel(type: CredentialType, params?: CredentialClaimParams): string {
  switch (type) {
    case "age":
      return `age ≥ ${params?.threshold_years ?? "18"}`;
    case "income":
      return `income > $${params?.threshold ?? "200000"}`;
    case "funds":
      return `balance > $${params?.threshold ?? "10000"}`;
    case "accreditation":
      return `net worth ≥ $${params?.threshold ?? "1000000"}`;
    case "employment":
      return `employed, seniority ≥ ${params?.threshold ?? "3"} yrs`;
    case "jurisdiction":
      return params?.mode === "1" ? "country in allowed list" : "country not restricted";
    default:
      return "identity verified";
  }
}

function parseIssuerKey(hex: string): bigint {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("CredentialFactory issuerPrivateKey must be 64 hex characters");
  }
  const k = BigInt("0x" + hex);
  if (k === 0n || k >= SECP_N)
    throw new Error("CredentialFactory issuerPrivateKey is out of range");
  return k;
}

/**
 * Builds credential JSON in the exact shape `/api/issue` returns. Every
 * credential passes `validateCredential` and carries a real secp256k1
 * signature over its commitment from this factory's issuer key (check it
 * with {@link verifyCredentialSignature}).
 */
export class CredentialFactory {
  readonly issuerId: string;
  readonly issuerName: string;
  /** Issuer secp256k1 public key coordinates, as on the credential. */
  readonly issuerPublicKey: { x: number[]; y: number[] };
  private readonly privateKey: bigint;
  private readonly now: () => number;

  constructor(options: CredentialFactoryOptions = {}) {
    this.privateKey = options.issuerPrivateKey
      ? parseIssuerKey(options.issuerPrivateKey)
      : randomScalar();
    this.issuerPublicKey = secpPublicKey(this.privateKey);
    this.issuerId = options.issuerId ?? Keypair.random().publicKey();
    this.issuerName = options.issuerName ?? "StellarCred Test Issuer";
    this.now = options.now ?? Date.now;
  }

  /** One signed credential. Each call gets its own salt and commitment unless given. */
  create(options: CreateCredentialOptions = {}): CredentialJson {
    const type = options.type ?? "kyc";
    if (!(CREDENTIAL_TYPES as readonly string[]).includes(type)) {
      throw new Error(`Unknown credential type: ${String(type)}`);
    }
    const commitment = options.commitment ?? randomField();
    const credential: CredentialJson = {
      type,
      title: options.title ?? TITLES[type],
      claim: options.claim ?? defaultClaimLabel(type, options.claimParams),
      issuer: this.issuerName,
      issuerId: this.issuerId,
      holder: options.holder ?? Keypair.random().publicKey(),
      value: options.value ?? "1",
      salt: options.salt ?? randomField(),
      commitment,
      sig: secpSign(commitmentDigest(commitment), this.privateKey),
      issuerPubX: [...this.issuerPublicKey.x],
      issuerPubY: [...this.issuerPublicKey.y],
      issuedAt: options.issuedAt ?? Math.floor(this.now() / 1000),
      expiry: options.expiry ?? "365 days",
    };
    if (type === "employment") credential.seniority = options.seniority ?? "5";
    if (options.claimParams) credential.claimParams = { ...options.claimParams };
    return credential;
  }

  /** One credential per type, all for the same holder. */
  createMany(
    types: readonly CredentialType[],
    options: Omit<CreateCredentialOptions, "type"> = {},
  ): CredentialJson[] {
    const holder = options.holder ?? Keypair.random().publicKey();
    return types.map((type) => this.create({ ...options, type, holder }));
  }
}

/**
 * True when `credential.sig` is a valid secp256k1 signature over
 * `credential.commitment` by `issuerPubX`/`issuerPubY`. Works on factory
 * credentials and on real issuer output. It does not check the commitment
 * opens to `value`/`salt`.
 */
export function verifyCredentialSignature(
  credential: Pick<CredentialJson, "commitment" | "sig" | "issuerPubX" | "issuerPubY">,
): boolean {
  try {
    return secpVerify(
      commitmentDigest(credential.commitment),
      credential.sig,
      credential.issuerPubX,
      credential.issuerPubY,
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MockProofRegistry
// ---------------------------------------------------------------------------

/** A simulated proof as the ProofRegistry stores it (u64 fields are bigint). */
export interface MockProofRecord {
  verified_at: bigint;
  expiry: bigint;
  revoked: boolean;
  issuer?: string;
  threshold?: bigint;
  vk_version: number;
  reason?: number;
}

export interface AddProofOptions {
  holder: string;
  type: string;
  /** Issuer address checked against `trustedIssuers`. */
  issuer?: string;
  /** Proven threshold for age, income, funds, accreditation, employment. */
  threshold?: number | bigint;
  /** Absolute expiry, Unix seconds. Wins over `expiresInSeconds`. */
  expiry?: number;
  /** Seconds from the registry's ledger time. Defaults to one year. */
  expiresInSeconds?: number;
  /** Unix seconds. Defaults to the registry's ledger time. */
  verifiedAt?: number;
  vkVersion?: number;
}

export type RevocationReason = "expired" | "superseded" | "fraud" | "user_request" | "other";

const REASON_CODES: Record<RevocationReason, number> = {
  expired: 0,
  superseded: 1,
  fraud: 2,
  user_request: 3,
  other: 4,
};

/** One recorded registry read, for assertions. */
export interface MockRegistryCall {
  method: "is_verified" | "check_claim" | "get_record" | "is_nullifier_used";
  args: Record<string, unknown>;
}

const DAYS_RE = /^\s*(\d+)\s*(day|days|d)?\s*$/i;

function thresholdOf(credential: CredentialJson): bigint | undefined {
  const raw =
    credential.type === "employment"
      ? credential.seniority
      : (credential.claimParams?.threshold_years ?? credential.claimParams?.threshold);
  return raw !== undefined && /^\d+$/.test(raw) ? BigInt(raw) : undefined;
}

/**
 * In-memory ProofRegistry. Reads follow the contract exactly: a proof counts
 * only while it is unrevoked and `expiry` is after the ledger time, a
 * `trusted_issuers` list rejects other issuers (and proofs with no issuer),
 * and `check_claim` compares the stored threshold against `min_threshold`.
 */
export class MockProofRegistry implements ProofRegistryReader {
  /** Every read made against this registry, oldest first. */
  readonly calls: MockRegistryCall[] = [];
  private readonly records = new Map<string, MockProofRecord>();
  private readonly nullifiers = new Set<string>();
  private ledgerTime: number | null = null;
  private failure: { error: unknown; remaining: number } | null = null;

  /** Ledger timestamp in Unix seconds (the real clock unless pinned). */
  now(): number {
    return this.ledgerTime ?? Math.floor(Date.now() / 1000);
  }

  /** Pin the ledger clock, in Unix seconds. `null` follows the real clock again. */
  setLedgerTime(seconds: number | null): this {
    this.ledgerTime = seconds;
    return this;
  }

  /** Move the ledger clock forward (pins it first if it was following the real clock). */
  advanceTime(seconds: number): this {
    this.ledgerTime = this.now() + seconds;
    return this;
  }

  /** Store a simulated proof, replacing any proof of that type for the holder. */
  addProof(options: AddProofOptions): MockProofRecord {
    const now = this.now();
    const record: MockProofRecord = {
      verified_at: BigInt(options.verifiedAt ?? now),
      expiry: BigInt(options.expiry ?? now + (options.expiresInSeconds ?? 365 * 86_400)),
      revoked: false,
      vk_version: options.vkVersion ?? 1,
    };
    if (options.issuer !== undefined) record.issuer = options.issuer;
    if (options.threshold !== undefined) record.threshold = BigInt(options.threshold);
    this.records.set(this.key(options.holder, options.type), record);
    return { ...record };
  }

  /**
   * Simulate a successful proof submission for `credential`: the holder,
   * type, issuer and threshold come from the credential, and the expiry from
   * its "N days" duration. Throws if the issuer signature does not verify, as
   * the real verifier would reject it.
   */
  prove(
    credential: CredentialJson,
    options: Partial<Omit<AddProofOptions, "holder" | "type">> = {},
  ): MockProofRecord {
    if (!verifyCredentialSignature(credential)) {
      throw new Error("MockProofRegistry.prove: credential signature does not verify");
    }
    const days = DAYS_RE.exec(credential.expiry);
    return this.addProof({
      holder: credential.holder,
      type: credential.type,
      issuer: credential.issuerId,
      threshold: thresholdOf(credential),
      ...(days && options.expiry === undefined && options.expiresInSeconds === undefined
        ? { expiresInSeconds: Number(days[1]) * 86_400 }
        : {}),
      ...options,
    });
  }

  /** Mark a stored proof revoked, as the issuer's `revoke` would. */
  revoke(holder: string, type: string, reason: RevocationReason = "other"): this {
    const record = this.records.get(this.key(holder, type));
    if (!record) throw new Error(`MockProofRegistry.revoke: no proof of "${type}" for ${holder}`);
    record.revoked = true;
    record.reason = REASON_CODES[reason];
    return this;
  }

  /** Delete a stored proof. */
  remove(holder: string, type: string): this {
    this.records.delete(this.key(holder, type));
    return this;
  }

  /** Record a consumed nullifier for `isNullifierUsed` / `verifyUniquePersonhood`. */
  useNullifier(appContext: string, nullifier: string): this {
    this.nullifiers.add(`${appContext}|${nullifier}`);
    return this;
  }

  /**
   * Make the next `times` reads throw `error` (default: one read, a generic
   * RPC failure), to exercise fail-soft and `throwOnError` paths. Note the
   * SDK retries transient errors, so use a non-retryable message such as
   * "bad request" or set `retryOptions` to keep tests fast.
   */
  failNextReads(error: unknown = new Error("bad request: simulated RPC failure"), times = 1): this {
    this.failure = { error, remaining: times };
    return this;
  }

  /** Drop every proof, nullifier, pinned clock, pending failure and recorded call. */
  reset(): this {
    this.records.clear();
    this.nullifiers.clear();
    this.ledgerTime = null;
    this.failure = null;
    this.calls.length = 0;
    return this;
  }

  // -- ProofRegistry read surface -------------------------------------------

  is_verified = async (args: {
    holder: string;
    credential_type: string;
    trusted_issuers?: string[] | null;
  }): Promise<{ result: readonly [boolean, bigint, bigint] }> => {
    this.begin("is_verified", args);
    const r = this.records.get(this.key(args.holder, args.credential_type));
    if (!r) return { result: [false, 0n, 0n] as const };
    const valid = this.isLive(r) && this.issuerTrusted(r, args.trusted_issuers);
    return { result: [valid, r.verified_at, r.expiry] as const };
  };

  check_claim = async (args: {
    holder: string;
    credential_type: string;
    min_threshold?: bigint | number | null;
    trusted_issuers?: string[] | null;
  }): Promise<{ result: boolean }> => {
    this.begin("check_claim", args);
    const r = this.records.get(this.key(args.holder, args.credential_type));
    if (!r || !this.isLive(r) || !this.issuerTrusted(r, args.trusted_issuers)) {
      return { result: false };
    }
    if (args.min_threshold === undefined || args.min_threshold === null) return { result: true };
    return { result: (r.threshold ?? 0n) >= BigInt(args.min_threshold) };
  };

  get_record = async (args: {
    holder: string;
    credential_type: string;
  }): Promise<{ result: MockProofRecord | undefined }> => {
    this.begin("get_record", args);
    const r = this.records.get(this.key(args.holder, args.credential_type));
    return { result: r ? { ...r } : undefined };
  };

  is_nullifier_used = async (args: {
    app_context: string;
    nullifier: string;
  }): Promise<{ result: boolean }> => {
    this.begin("is_nullifier_used", args);
    return { result: this.nullifiers.has(`${args.app_context}|${args.nullifier}`) };
  };

  // -- internals -------------------------------------------------------------

  private key(holder: string, type: string): string {
    return `${holder}|${type}`;
  }

  private isLive(r: MockProofRecord): boolean {
    return !r.revoked && r.expiry > BigInt(this.now());
  }

  private issuerTrusted(r: MockProofRecord, trusted?: string[] | null): boolean {
    if (!trusted) return true;
    return r.issuer !== undefined && trusted.includes(r.issuer);
  }

  private begin(method: MockRegistryCall["method"], args: object): void {
    this.calls.push({ method, args: { ...args } as Record<string, unknown> });
    if (this.failure && this.failure.remaining > 0) {
      this.failure.remaining -= 1;
      const { error } = this.failure;
      if (this.failure.remaining === 0) this.failure = null;
      throw error;
    }
  }
}

let _installed: MockProofRegistry | null = null;

/**
 * Route every SDK ProofRegistry read to `registry` (a new one when omitted)
 * and return it. No `registryId` or RPC is needed while it is installed.
 * Call {@link uninstallMockRegistry} in `afterEach`.
 */
export function installMockRegistry(
  registry: MockProofRegistry = new MockProofRegistry(),
): MockProofRegistry {
  _installed = registry;
  __setProofRegistryClientForTesting(registry);
  return registry;
}

/** Restore the real ProofRegistry client. Safe to call when nothing is installed. */
export function uninstallMockRegistry(): void {
  _installed = null;
  __setProofRegistryClientForTesting(null);
}

/** The registry {@link installMockRegistry} installed, or `null`. */
export function getInstalledMockRegistry(): MockProofRegistry | null {
  return _installed;
}
