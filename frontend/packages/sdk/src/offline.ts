// @stellarcred/sdk — offline (air-gapped) presentation verification (#1059)
//
// Air-gapped verification devices — border-control desks, venue-entry
// terminals, kiosks on a locked-down network — cannot reach a Soroban RPC
// endpoint. This module verifies a zero-knowledge presentation using only data
// that is already on the device:
//
//   1. a locally cached verifier key (one per credential type / VK version),
//   2. a locally cached state snapshot (claim records, consumed nullifiers,
//      issuer keys, revocation material), and
//   3. an UltraHonk proof verifier that runs locally (bb.js WASM, a native
//      verifier, or a test double).
//
// Nothing here performs I/O. There is no `fetch`, no RPC client, no dynamic
// configuration: the module has no way to reach the network even by accident.
// That is deliberate — an offline verifier that can silently fall back to the
// network is not an offline verifier.
//
// ## Trust model
//
// The cached snapshot and verifier keys are a *point-in-time copy* of chain
// state. Verification proves:
//
//   • the proof was produced for one of the cached verifier keys,
//   • the key is not deprecated (unless explicitly allowed),
//   • the snapshot contains a non-revoked, unexpired claim for the holder and
//     credential type, with a matching VK version, commitment, issuer and
//     threshold,
//   • the presentation's public inputs really contain the commitment / issuer
//     key / Merkle root it claims,
//   • the nullifier has not already been consumed in this application context,
//   • the UltraHonk proof verifies against the cached verifier key.
//
// It cannot prove the snapshot is the *latest* chain state. Devices must
// refresh the snapshot on their own schedule and should treat a stale snapshot
// as a hard failure (see `maxSnapshotAgeSeconds`). The default is 24 hours.
//
// ## Public inputs
//
// `public_inputs` is the proof's flat list of 32-byte big-endian field elements,
// concatenated. Noir flattens its ABI into that list: a `Field` or integer is
// one field, while a `[u8; N]` (the issuer key, for example) becomes N
// single-byte fields. The verifier accepts either encoding when it binds a
// cached 64-byte issuer key, so callers pass the prover's output through
// untouched.
//
// ## Snapshot format
//
// The snapshot deliberately reuses the indexer's wire shape for claim rows
// (`wallet`, `credential_type`, `verified_at`, `expiry`, `issuer`, `revoked`,
// `threshold`, `ledger_sequence`). A terminal can persist `GET /claims` output
// verbatim and add the top-level metadata (`snapshotVersion`, `capturedAt`,
// `ledgerSequence`), optionally enriching rows with `commitment`,
// `issuer_pub_key` and `vk_version` when its exporter has them.
//
// ## Usage
//
//   import { createOfflineVerifier } from "@stellarcred/sdk";
//
//   const verifier = createOfflineVerifier({
//     verifierKeys: JSON.parse(readFileSync("cache/vks.json", "utf8")),
//     stateSnapshot: JSON.parse(readFileSync("cache/state.json", "utf8")),
//     trustedIssuers: ["GBBB…"],
//   });
//
//   const result = await verifier.verify({
//     credential_type: "age",
//     holder: "GAAA…",
//     proof: "0x…",          // UltraHonk proof bytes, hex
//     public_inputs: "0x…",  // concatenated 32-byte field elements, hex
//     vk_version: 1,
//     issuer_id: "GBBB…",
//     issuer_pub_key: "0x…", // 64 bytes: x || y
//     commitment: "0x…",
//     min_threshold: 18,
//   });
//
//   if (!result.valid) console.error(result.code, result.message);

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

/** Fixed UltraHonk proof size enforced by CredentialVerifier. */
export const ULTRAHONK_PROOF_BYTES = 14_592;

/** Size of a BN254/BLS12-381 field element as the contract serializes it. */
export const OFFLINE_FIELD_BYTES = 32;

/** The only state-snapshot schema version this module understands. */
export const OFFLINE_SNAPSHOT_VERSION = 1;

/** Default maximum age of a state snapshot: 24 hours, in seconds. */
export const DEFAULT_MAX_SNAPSHOT_AGE_SECONDS = 86_400;

/** Default tolerated clock skew for future-dated snapshots, in seconds. */
export const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Bytes may be supplied as a `Uint8Array`, a `number[]` of octets, or a hex
 * string (with or without a `0x` prefix). Hex is what a terminal will have
 * after reading a JSON cache file.
 */
export type OfflineBytes = Uint8Array | readonly number[] | string;

/**
 * Why a presentation was rejected. Codes are stable and safe to log; callers
 * should branch on them rather than parsing messages.
 */
export type OfflineVerificationCode =
  | "valid"
  | "invalid_presentation"
  | "invalid_state_snapshot"
  | "invalid_verifier_key"
  | "stale_state_snapshot"
  | "network_mismatch"
  | "missing_verifier_key"
  | "deprecated_verifier_key"
  | "no_proof_record"
  | "revoked"
  | "expired"
  | "vk_version_mismatch"
  | "commitment_mismatch"
  | "public_inputs_mismatch"
  | "issuer_untrusted"
  | "issuer_key_missing"
  | "issuer_key_mismatch"
  | "merkle_root_mismatch"
  | "threshold_not_met"
  | "nullifier_reused"
  | "proof_invalid"
  | "proof_backend_missing"
  | "proof_backend_error"
  | "internal_error";

/** One step in the verification trace, so a terminal can log exactly where it stopped. */
export interface OfflineCheck {
  /** Stable check identifier, e.g. `"snapshot_freshness"`. */
  name: string;
  ok: boolean;
  /** Human-readable detail, safe to log (never includes private inputs). */
  detail?: string;
}

/** A locally cached verifier key for one credential type / VK version. */
export interface CachedVerifierKey {
  /** Credential type, e.g. `"kyc"`, `"age"`, `"aggregate"`. */
  credential_type: string;
  /** On-chain VK counter (CredentialVerifier `set_vk`). Must be >= 1. */
  vk_version: number;
  /** Serialized UltraHonk verification-key blob (hex). */
  vk: OfflineBytes;
  /**
   * Optional Noir circuit artifact `bytecode` (the base64 string inside
   * `circuits/<type>.json`). Required only by the built-in bb.js proof
   * verifier, which derives the VK from the artifact; ignored when a custom
   * `proofVerifier` is supplied.
   */
  circuit_bytecode?: string;
  /** True once the key has been deprecated on-chain. */
  deprecated?: boolean;
}

/**
 * A claim row in a cached state snapshot. Field names follow the indexer's
 * `/claims` wire shape so an export can be reused verbatim.
 */
export interface OfflineSnapshotClaim {
  /** Holder address. */
  wallet: string;
  credential_type: string;
  /** Issuer address, or `""` for a record with no issuer (indexer encoding). */
  issuer?: string;
  /** Unix seconds. */
  verified_at: number;
  /** Unix seconds; `0` means "no expiry". */
  expiry: number;
  ledger_sequence?: number;
  threshold?: number | null;
  /** Accepts a boolean or the indexer's `0`/`1`. */
  revoked?: boolean | number;
  reason_code?: string;
  /**
   * Optional 32-byte commitment. When present it is bound to the presentation
   * and to `revokedCommitments`.
   */
  commitment?: string;
  /** Optional 64-byte issuer public key (x || y) in hex. */
  issuer_pub_key?: string;
  /** VK version the claim was verified with, when known. */
  vk_version?: number;
}

/** A nullifier already consumed in an application context. */
export interface OfflineNullifier {
  /** 32-byte application context, hex. */
  app_context: string;
  /** 32-byte nullifier, hex. */
  nullifier: string;
}

/**
 * A locally cached snapshot of the state a verifier needs. Produced by a
 * trusted exporter while the device still had connectivity, then carried to
 * the air-gapped device.
 */
export interface OfflineStateSnapshot {
  /** Must be {@link OFFLINE_SNAPSHOT_VERSION}. */
  snapshotVersion: number;
  /** Unix seconds when the snapshot was captured. */
  capturedAt: number;
  /** Ledger the snapshot reflects. */
  ledgerSequence: number;
  /** Optional; checked against the verifier's expected network passphrase. */
  networkPassphrase?: string;
  /** Claim rows, indexer-shaped. */
  claims: readonly OfflineSnapshotClaim[];
  /** Nullifiers consumed per application context (Sybil resistance). */
  nullifiers?: readonly OfflineNullifier[];
  /** issuer address → accepted 64-byte public keys (hex). */
  issuerKeys?: Readonly<Record<string, readonly string[]>>;
  /** Commitments revoked out-of-band (32-byte hex). */
  revokedCommitments?: readonly string[];
  /** Merkle root the snapshot reflects, when the deployment uses one. */
  merkleRoot?: string;
}

/** The presentation a holder presents to an air-gapped terminal. */
export interface OfflinePresentation {
  credential_type: string;
  holder: string;
  /** UltraHonk proof bytes. */
  proof: OfflineBytes;
  /** Concatenated 32-byte big-endian field elements. */
  public_inputs: OfflineBytes;
  /**
   * VK version the proof targets. Omit to use the newest cached,
   * non-deprecated version for the credential type.
   */
  vk_version?: number;
  /** Issuer address claimed by the holder. */
  issuer_id?: string;
  /** 64-byte issuer public key (x || y) claimed by the holder. */
  issuer_pub_key?: OfflineBytes;
  /** 32-byte commitment claimed by the holder. */
  commitment?: OfflineBytes;
  /** 32-byte Merkle root claimed by the holder. */
  merkle_root?: OfflineBytes;
  /** 32-byte application context for nullifier checks. */
  app_context?: string;
  /** 32-byte nullifier presented by the holder. */
  nullifier?: OfflineBytes;
  /** Threshold the verifier requires (e.g. age 18, income 50 000). */
  min_threshold?: number;
}

/** Inputs handed to a local proof-checking backend. */
export interface OfflineProofVerificationInput {
  /** Serialized verification key from the cache. */
  verifierKey: Uint8Array;
  /** Raw UltraHonk proof bytes. */
  proof: Uint8Array;
  /** Concatenated 32-byte public inputs. */
  publicInputs: Uint8Array;
  credentialType: string;
  vkVersion: number;
  /** The cached circuit bytecode, when the key carries it. */
  circuitBytecode?: string;
}

/**
 * A local UltraHonk verifier. Return `true` only when the proof verifies
 * against the supplied key. Errors are surfaced as `proof_backend_error`.
 */
export type OfflineProofVerifier = (
  input: OfflineProofVerificationInput,
) => boolean | Promise<boolean>;

export interface OfflineVerifierOptions {
  /** One entry per cached (credential type, VK version). */
  verifierKeys: readonly CachedVerifierKey[];
  /** The cached chain snapshot. */
  stateSnapshot: OfflineStateSnapshot;
  /** If set, presentations must name one of these issuers. */
  trustedIssuers?: readonly string[];
  /** Per-type minimum threshold applied when the presentation omits one. */
  minThresholds?: Readonly<Record<string, number>>;
  /**
   * Override the time source, in Unix seconds. A function is re-evaluated on
   * every verification, so a long-lived terminal keeps seeing the real clock.
   */
  now?: number | (() => number);
  /**
   * Maximum age of `stateSnapshot.capturedAt`, in seconds. Defaults to 24
   * hours. Raise it deliberately for devices that refresh on a slower cycle;
   * a stale snapshot is a security failure, not a warning.
   */
  maxSnapshotAgeSeconds?: number;
  /** Tolerated clock skew for future-dated snapshots. Default 300 seconds. */
  maxClockSkewSeconds?: number;
  /**
   * When the verifier is configured with a network passphrase, a snapshot
   * carrying a different one is rejected. Off by default.
   */
  networkPassphrase?: string;
  /** Allow proofs against a deprecated verifier key. Default `false`. */
  allowDeprecatedKeys?: boolean;
  /**
   * Local proof backend. When omitted, the built-in bb.js adapter is used,
   * which requires `circuit_bytecode` on the selected verifier key and the
   * optional `@aztec/bb.js` package to be installed on the device.
   */
  proofVerifier?: OfflineProofVerifier;
}

/** Successful verification, with the claim material the terminal may log. */
export interface OfflineVerificationSuccess {
  valid: true;
  code: "valid";
  credentialType: string;
  vkVersion: number;
  holder: string;
  issuerId?: string;
  commitment?: string;
  /** Unix seconds when the claim was recorded on-chain. */
  verifiedAt: number;
  /** Unix seconds; `0` means "no expiry". */
  expiry: number;
  /** Ledger the cached snapshot reflects. */
  snapshotLedgerSequence: number;
  checks: readonly OfflineCheck[];
}

/** Rejected presentation. Always safe to log and display a generic denial for. */
export interface OfflineVerificationFailure {
  valid: false;
  code: Exclude<OfflineVerificationCode, "valid">;
  message: string;
  checks: readonly OfflineCheck[];
}

export type OfflineVerificationResult = OfflineVerificationSuccess | OfflineVerificationFailure;

/** Verification API returned by {@link createOfflineVerifier}. */
export interface OfflineVerifier {
  /** Verify one presentation. Never throws; failures are returned. */
  verify(presentation: OfflinePresentation): Promise<OfflineVerificationResult>;
  /** Verify several presentations with the same cached state. */
  verifyAll(presentations: readonly OfflinePresentation[]): Promise<OfflineVerificationResult[]>;
}

/** Thrown for malformed configuration or presentations. */
export class OfflineVerificationError extends Error {
  readonly code: Exclude<OfflineVerificationCode, "valid">;

  constructor(code: Exclude<OfflineVerificationCode, "valid">, message: string) {
    super(message);
    this.name = "OfflineVerificationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

const HEX_RE = /^[0-9a-fA-F]*$/;

function toBytes(
  value: OfflineBytes | undefined,
  field: string,
  code: "invalid_presentation" | "invalid_state_snapshot" | "invalid_verifier_key",
): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined;

  if (value instanceof Uint8Array) {
    if (value.length === 0) throw new OfflineVerificationError(code, `${field} is empty`);
    return value;
  }

  if (Array.isArray(value)) {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const byte = value[i];
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new OfflineVerificationError(code, `${field}[${i}] is not an octet (0-255)`);
      }
      bytes[i] = byte;
    }
    if (bytes.length === 0) throw new OfflineVerificationError(code, `${field} is empty`);
    return bytes;
  }

  if (typeof value === "string") {
    const hex = value.trim().replace(/^0x/i, "");
    if (hex.length === 0) throw new OfflineVerificationError(code, `${field} is empty`);
    if (hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
      throw new OfflineVerificationError(code, `${field} must be an even-length hex string`);
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  throw new OfflineVerificationError(code, `${field} must be bytes or a hex string`);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function normalizeHex(value: string, field: string, expectedBytes?: number): string {
  const hex = value.trim().replace(/^0x/i, "").toLowerCase();
  if (hex.length === 0 || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      `${field} must be an even-length hex string`,
    );
  }
  if (expectedBytes !== undefined && hex.length !== expectedBytes * 2) {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      `${field} must be ${expectedBytes} bytes`,
    );
  }
  return hex;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonNegativeInteger(
  value: unknown,
  field: string,
  code: "invalid_state_snapshot" | "invalid_presentation" | "invalid_verifier_key",
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new OfflineVerificationError(code, `${field} must be a non-negative integer`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Snapshot normalization
// ---------------------------------------------------------------------------

interface NormalizedClaim {
  wallet: string;
  credentialType: string;
  issuer?: string;
  verifiedAt: number;
  expiry: number;
  ledgerSequence?: number;
  threshold?: number;
  revoked: boolean;
  reasonCode?: string;
  commitment?: string;
  issuerPubKey?: string;
  vkVersion?: number;
}

interface NormalizedSnapshot {
  capturedAt: number;
  ledgerSequence: number;
  networkPassphrase?: string;
  claims: Map<string, NormalizedClaim>;
  nullifiers: Set<string>;
  issuerKeys: Map<string, Set<string>>;
  revokedCommitments: Set<string>;
  merkleRoot?: string;
}

function claimKey(wallet: string, credentialType: string): string {
  return `${wallet}|${credentialType}`;
}

function normalizeClaim(raw: unknown, index: number): NormalizedClaim {
  const claim = asRecord(raw);
  if (!claim) {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      `claims[${index}] must be an object`,
    );
  }

  const wallet = claim.wallet;
  if (typeof wallet !== "string" || wallet.trim() === "") {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      `claims[${index}].wallet must be a non-empty string`,
    );
  }

  const credentialType = claim.credential_type;
  if (typeof credentialType !== "string" || credentialType.trim() === "") {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      `claims[${index}].credential_type must be a non-empty string`,
    );
  }

  const verifiedAt = asNonNegativeInteger(
    claim.verified_at,
    `claims[${index}].verified_at`,
    "invalid_state_snapshot",
  );
  if (verifiedAt === undefined) {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      `claims[${index}].verified_at is required`,
    );
  }

  const expiry = asNonNegativeInteger(
    claim.expiry,
    `claims[${index}].expiry`,
    "invalid_state_snapshot",
  );
  if (expiry === undefined) {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      `claims[${index}].expiry is required`,
    );
  }

  let revoked = false;
  if (claim.revoked !== undefined && claim.revoked !== null) {
    if (typeof claim.revoked === "boolean") revoked = claim.revoked;
    else if (typeof claim.revoked === "number" && (claim.revoked === 0 || claim.revoked === 1)) {
      revoked = claim.revoked === 1;
    } else {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        `claims[${index}].revoked must be a boolean or 0/1`,
      );
    }
  }

  let issuer: string | undefined;
  if (claim.issuer !== undefined && claim.issuer !== null) {
    if (typeof claim.issuer !== "string") {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        `claims[${index}].issuer must be a string`,
      );
    }
    issuer = claim.issuer.trim() === "" ? undefined : claim.issuer.trim();
  }

  let threshold: number | undefined;
  if (claim.threshold !== undefined && claim.threshold !== null) {
    threshold = asNonNegativeInteger(
      claim.threshold,
      `claims[${index}].threshold`,
      "invalid_state_snapshot",
    );
  }

  const ledgerSequence = asNonNegativeInteger(
    claim.ledger_sequence,
    `claims[${index}].ledger_sequence`,
    "invalid_state_snapshot",
  );
  const vkVersion = asNonNegativeInteger(
    claim.vk_version,
    `claims[${index}].vk_version`,
    "invalid_state_snapshot",
  );
  if (vkVersion !== undefined && vkVersion < 1) {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      `claims[${index}].vk_version must be >= 1`,
    );
  }

  let commitment: string | undefined;
  if (claim.commitment !== undefined && claim.commitment !== null) {
    if (typeof claim.commitment !== "string") {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        `claims[${index}].commitment must be a hex string`,
      );
    }
    commitment = normalizeHex(claim.commitment, `claims[${index}].commitment`, OFFLINE_FIELD_BYTES);
  }

  let issuerPubKey: string | undefined;
  if (claim.issuer_pub_key !== undefined && claim.issuer_pub_key !== null) {
    if (typeof claim.issuer_pub_key !== "string") {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        `claims[${index}].issuer_pub_key must be a hex string`,
      );
    }
    issuerPubKey = normalizeHex(
      claim.issuer_pub_key,
      `claims[${index}].issuer_pub_key`,
      OFFLINE_FIELD_BYTES * 2,
    );
  }

  let reasonCode: string | undefined;
  if (claim.reason_code !== undefined && claim.reason_code !== null) {
    if (typeof claim.reason_code !== "string") {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        `claims[${index}].reason_code must be a string`,
      );
    }
    reasonCode = claim.reason_code;
  }

  return {
    wallet,
    credentialType,
    issuer,
    verifiedAt,
    expiry,
    ledgerSequence,
    threshold,
    revoked,
    reasonCode,
    commitment,
    issuerPubKey,
    vkVersion,
  };
}

function normalizeSnapshot(raw: OfflineStateSnapshot): NormalizedSnapshot {
  const snapshot = asRecord(raw);
  if (!snapshot) {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      "state snapshot must be an object",
    );
  }

  if (snapshot.snapshotVersion !== OFFLINE_SNAPSHOT_VERSION) {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      `unsupported snapshotVersion ${String(snapshot.snapshotVersion)}; expected ${OFFLINE_SNAPSHOT_VERSION}`,
    );
  }

  const capturedAt = asNonNegativeInteger(
    snapshot.capturedAt,
    "capturedAt",
    "invalid_state_snapshot",
  );
  if (capturedAt === undefined) {
    throw new OfflineVerificationError("invalid_state_snapshot", "capturedAt is required");
  }

  const ledgerSequence = asNonNegativeInteger(
    snapshot.ledgerSequence,
    "ledgerSequence",
    "invalid_state_snapshot",
  );
  if (ledgerSequence === undefined) {
    throw new OfflineVerificationError("invalid_state_snapshot", "ledgerSequence is required");
  }

  let networkPassphrase: string | undefined;
  if (snapshot.networkPassphrase !== undefined && snapshot.networkPassphrase !== null) {
    if (typeof snapshot.networkPassphrase !== "string" || snapshot.networkPassphrase === "") {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        "networkPassphrase must be a non-empty string",
      );
    }
    networkPassphrase = snapshot.networkPassphrase;
  }

  if (snapshot.claims !== undefined && !Array.isArray(snapshot.claims)) {
    throw new OfflineVerificationError("invalid_state_snapshot", "claims must be an array");
  }
  const rawClaims = Array.isArray(snapshot.claims) ? snapshot.claims : [];

  // One record per (wallet, credential_type), like the contract. If an export
  // contains several (replaying an append-only history), the newest verified_at
  // wins deterministically.
  const claims = new Map<string, NormalizedClaim>();
  rawClaims.forEach((rawClaim, index) => {
    const claim = normalizeClaim(rawClaim, index);
    const key = claimKey(claim.wallet, claim.credentialType);
    const existing = claims.get(key);
    if (!existing || claim.verifiedAt >= existing.verifiedAt) claims.set(key, claim);
  });

  const nullifiers = new Set<string>();
  if (snapshot.nullifiers !== undefined) {
    if (!Array.isArray(snapshot.nullifiers)) {
      throw new OfflineVerificationError("invalid_state_snapshot", "nullifiers must be an array");
    }
    snapshot.nullifiers.forEach((rawNullifier, index) => {
      const entry = asRecord(rawNullifier);
      if (!entry || typeof entry.app_context !== "string" || typeof entry.nullifier !== "string") {
        throw new OfflineVerificationError(
          "invalid_state_snapshot",
          `nullifiers[${index}] must have app_context and nullifier hex strings`,
        );
      }
      nullifiers.add(
        `${normalizeHex(entry.app_context, `nullifiers[${index}].app_context`, OFFLINE_FIELD_BYTES)}|${normalizeHex(
          entry.nullifier,
          `nullifiers[${index}].nullifier`,
          OFFLINE_FIELD_BYTES,
        )}`,
      );
    });
  }

  const issuerKeys = new Map<string, Set<string>>();
  if (snapshot.issuerKeys !== undefined && snapshot.issuerKeys !== null) {
    const record = asRecord(snapshot.issuerKeys);
    if (!record) {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        "issuerKeys must be an object keyed by issuer address",
      );
    }
    for (const [issuer, keys] of Object.entries(record)) {
      if (issuer.trim() === "" || !Array.isArray(keys)) {
        throw new OfflineVerificationError(
          "invalid_state_snapshot",
          `issuerKeys["${issuer}"] must be an array of 64-byte hex keys`,
        );
      }
      const normalized = new Set<string>();
      keys.forEach((key, index) => {
        if (typeof key !== "string") {
          throw new OfflineVerificationError(
            "invalid_state_snapshot",
            `issuerKeys["${issuer}"][${index}] must be a hex string`,
          );
        }
        normalized.add(
          normalizeHex(key, `issuerKeys["${issuer}"][${index}]`, OFFLINE_FIELD_BYTES * 2),
        );
      });
      issuerKeys.set(issuer, normalized);
    }
  }

  const revokedCommitments = new Set<string>();
  if (snapshot.revokedCommitments !== undefined) {
    if (!Array.isArray(snapshot.revokedCommitments)) {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        "revokedCommitments must be an array",
      );
    }
    snapshot.revokedCommitments.forEach((commitment, index) => {
      if (typeof commitment !== "string") {
        throw new OfflineVerificationError(
          "invalid_state_snapshot",
          `revokedCommitments[${index}] must be a hex string`,
        );
      }
      revokedCommitments.add(
        normalizeHex(commitment, `revokedCommitments[${index}]`, OFFLINE_FIELD_BYTES),
      );
    });
  }

  let merkleRoot: string | undefined;
  if (snapshot.merkleRoot !== undefined && snapshot.merkleRoot !== null) {
    if (typeof snapshot.merkleRoot !== "string") {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        "merkleRoot must be a hex string",
      );
    }
    merkleRoot = normalizeHex(snapshot.merkleRoot, "merkleRoot", OFFLINE_FIELD_BYTES);
  }

  return {
    capturedAt,
    ledgerSequence,
    networkPassphrase,
    claims,
    nullifiers,
    issuerKeys,
    revokedCommitments,
    merkleRoot,
  };
}

// ---------------------------------------------------------------------------
// Verifier-key normalization
// ---------------------------------------------------------------------------

interface NormalizedKey {
  credentialType: string;
  vkVersion: number;
  vk: Uint8Array;
  circuitBytecode?: string;
  deprecated: boolean;
}

function normalizeVerifierKeys(keys: readonly CachedVerifierKey[]): Map<string, NormalizedKey> {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new OfflineVerificationError(
      "invalid_verifier_key",
      "verifierKeys must contain at least one cached key",
    );
  }

  const byType = new Map<string, NormalizedKey>();
  keys.forEach((raw, index) => {
    const key = asRecord(raw);
    if (!key) {
      throw new OfflineVerificationError(
        "invalid_verifier_key",
        `verifierKeys[${index}] must be an object`,
      );
    }
    if (typeof key.credential_type !== "string" || key.credential_type.trim() === "") {
      throw new OfflineVerificationError(
        "invalid_verifier_key",
        `verifierKeys[${index}].credential_type must be a non-empty string`,
      );
    }
    const vkVersion = asNonNegativeInteger(
      key.vk_version,
      `verifierKeys[${index}].vk_version`,
      "invalid_verifier_key",
    );
    if (vkVersion === undefined || vkVersion < 1) {
      throw new OfflineVerificationError(
        "invalid_verifier_key",
        `verifierKeys[${index}].vk_version must be >= 1`,
      );
    }
    const vk = toBytes(key.vk as OfflineBytes, `verifierKeys[${index}].vk`, "invalid_verifier_key");
    if (!vk) {
      throw new OfflineVerificationError(
        "invalid_verifier_key",
        `verifierKeys[${index}].vk is required`,
      );
    }

    let circuitBytecode: string | undefined;
    if (key.circuit_bytecode !== undefined && key.circuit_bytecode !== null) {
      if (typeof key.circuit_bytecode !== "string" || key.circuit_bytecode.trim() === "") {
        throw new OfflineVerificationError(
          "invalid_verifier_key",
          `verifierKeys[${index}].circuit_bytecode must be a non-empty string`,
        );
      }
      circuitBytecode = key.circuit_bytecode;
    }

    if (key.deprecated !== undefined && typeof key.deprecated !== "boolean") {
      throw new OfflineVerificationError(
        "invalid_verifier_key",
        `verifierKeys[${index}].deprecated must be a boolean`,
      );
    }

    const credentialType = key.credential_type;
    const mapKey = `${credentialType}|${vkVersion}`;
    if (byType.has(mapKey)) {
      throw new OfflineVerificationError(
        "invalid_verifier_key",
        `duplicate cached verifier key for ${credentialType} vk_version ${vkVersion}`,
      );
    }

    byType.set(mapKey, {
      credentialType,
      vkVersion,
      vk,
      circuitBytecode,
      deprecated: key.deprecated === true,
    });
  });

  return byType;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function resolveNow(now: OfflineVerifierOptions["now"]): number {
  const value = typeof now === "function" ? now() : (now ?? Math.floor(Date.now() / 1000));
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OfflineVerificationError(
      "invalid_presentation",
      "now() must return a finite Unix timestamp in seconds",
    );
  }
  return Math.floor(value);
}

function splitFields(publicInputs: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  for (let i = 0; i < publicInputs.length; i += OFFLINE_FIELD_BYTES) {
    fields.push(publicInputs.subarray(i, i + OFFLINE_FIELD_BYTES));
  }
  return fields;
}

function containsField(fields: readonly Uint8Array[], target: Uint8Array): boolean {
  return fields.some((field) => bytesEqual(field, target));
}

/**
 * True when `target` appears in the proof's public inputs, in either encoding
 * Noir uses: packed as consecutive 32-byte fields (`Field`, `u64`, or a byte
 * array a prover chose to pack), or expanded into one single-byte field per
 * element — which is what bb.js emits for `[u8; N]` public inputs such as the
 * issuer key.
 */
function containsBytes(fields: readonly Uint8Array[], target: Uint8Array): boolean {
  const packedLength = target.length / OFFLINE_FIELD_BYTES;
  if (Number.isInteger(packedLength) && packedLength > 0) {
    for (let start = 0; start + packedLength <= fields.length; start++) {
      let matched = true;
      for (let i = 0; i < packedLength; i++) {
        if (
          !bytesEqual(
            fields[start + i],
            target.subarray(i * OFFLINE_FIELD_BYTES, (i + 1) * OFFLINE_FIELD_BYTES),
          )
        ) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
  }

  for (let start = 0; start + target.length <= fields.length; start++) {
    let matched = true;
    for (let i = 0; i < target.length && matched; i++) {
      const field = fields[start + i];
      if (field[field.length - 1] !== target[i]) matched = false;
      else if (field.subarray(0, field.length - 1).some((byte) => byte !== 0)) matched = false;
    }
    if (matched) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Built-in bb.js proof verifier
// ---------------------------------------------------------------------------

/** Minimal surface of `@aztec/bb.js` used for offline verification. */
export interface BbJsModuleLike {
  UltraHonkBackend: new (
    bytecode: string,
    options?: Record<string, unknown>,
  ) => {
    verifyProof: (
      proofData: { proof: Uint8Array; publicInputs: string[] },
      options?: Record<string, unknown>,
    ) => Promise<boolean>;
    destroy?: () => Promise<void>;
  };
}

async function loadBbJs(): Promise<BbJsModuleLike> {
  // Non-literal specifier: `@aztec/bb.js` is an optional, device-provided
  // dependency, not part of this package's dependency graph. Keeping the
  // specifier out of the module graph means bundlers never pull WASM into an
  // SDK consumer that only reads claims online.
  const specifier = "@aztec/bb.js";
  return (await import(specifier)) as unknown as BbJsModuleLike;
}

/**
 * Build an offline proof verifier backed by bb.js' `UltraHonkBackend`. bb.js
 * derives the verification key from the circuit artifact it is constructed
 * with, so the selected cache entry must carry `circuit_bytecode` (the base64
 * `bytecode` string inside `circuits/<type>.json`). A native verifier consumes
 * `vk` instead; that field is not used here.
 *
 * Verification runs single-threaded, so a terminal needs neither
 * SharedArrayBuffer nor cross-origin isolation. `loadBb` is injectable so a
 * terminal can load a vendored bb.js build from local disk, and so unit tests
 * never need the WASM package.
 */
export function createBbJsProofVerifier(
  loadBb: () => Promise<BbJsModuleLike> = loadBbJs,
  verifyOptions: Record<string, unknown> = { keccak: true },
): OfflineProofVerifier {
  return async (input) => {
    if (!input.circuitBytecode) {
      throw new OfflineVerificationError(
        "proof_backend_missing",
        "the cached verifier key has no circuit_bytecode, which the built-in bb.js verifier needs; supply a custom proofVerifier or cache the circuit artifact",
      );
    }

    let bbModule: BbJsModuleLike;
    try {
      bbModule = await loadBb();
    } catch (err) {
      throw new OfflineVerificationError(
        "proof_backend_missing",
        `local bb.js verifier could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const backend = new bbModule.UltraHonkBackend(input.circuitBytecode, { threads: 1 });
    try {
      const publicInputs = splitFields(input.publicInputs).map((field) => `0x${toHex(field)}`);
      return await backend.verifyProof({ proof: input.proof, publicInputs }, verifyOptions);
    } finally {
      await backend.destroy?.().catch(() => undefined);
    }
  };
}

const defaultProofVerifier = createBbJsProofVerifier();

// ---------------------------------------------------------------------------
// Core verifier
// ---------------------------------------------------------------------------

interface VerificationContext {
  options: OfflineVerifierOptions;
  snapshot: NormalizedSnapshot;
  keys: Map<string, NormalizedKey>;
  proofVerifier: OfflineProofVerifier;
}

function fail(
  code: Exclude<OfflineVerificationCode, "valid">,
  message: string,
  checks: readonly OfflineCheck[],
): OfflineVerificationFailure {
  return { valid: false, code, message, checks };
}

function selectVerifierKey(
  presentation: OfflinePresentation,
  ctx: VerificationContext,
): NormalizedKey | null {
  const { keys } = ctx;

  if (presentation.vk_version !== undefined) {
    return keys.get(`${presentation.credential_type}|${presentation.vk_version}`) ?? null;
  }

  let best: NormalizedKey | null = null;
  for (const key of keys.values()) {
    if (key.credentialType !== presentation.credential_type) continue;
    if (key.deprecated && !ctx.options.allowDeprecatedKeys) continue;
    if (!best || key.vkVersion > best.vkVersion) best = key;
  }
  return best;
}

function findClaim(
  snapshot: NormalizedSnapshot,
  holder: string,
  credentialType: string,
): NormalizedClaim | undefined {
  return snapshot.claims.get(claimKey(holder, credentialType));
}

async function runVerification(
  presentation: OfflinePresentation,
  ctx: VerificationContext,
): Promise<OfflineVerificationResult> {
  const checks: OfflineCheck[] = [];
  const pass = (name: string, detail?: string) => {
    checks.push({ name, ok: true, detail });
  };
  const reject = (
    code: Exclude<OfflineVerificationCode, "valid">,
    message: string,
    name: string,
  ): OfflineVerificationFailure => {
    checks.push({ name, ok: false, detail: message });
    return fail(code, message, checks);
  };

  // ── 1. Presentation shape ────────────────────────────────────────────────
  if (!presentation || typeof presentation !== "object") {
    return reject("invalid_presentation", "presentation must be an object", "presentation_shape");
  }
  if (
    typeof presentation.credential_type !== "string" ||
    presentation.credential_type.trim() === ""
  ) {
    return reject(
      "invalid_presentation",
      "credential_type must be a non-empty string",
      "presentation_shape",
    );
  }
  if (typeof presentation.holder !== "string" || presentation.holder.trim() === "") {
    return reject(
      "invalid_presentation",
      "holder must be a non-empty string",
      "presentation_shape",
    );
  }

  let proof: Uint8Array;
  let publicInputs: Uint8Array;
  let commitment: Uint8Array | undefined;
  let issuerPubKey: Uint8Array | undefined;
  let merkleRoot: Uint8Array | undefined;
  let nullifier: Uint8Array | undefined;

  try {
    const decodedProof = toBytes(presentation.proof, "proof", "invalid_presentation");
    const decodedInputs = toBytes(
      presentation.public_inputs,
      "public_inputs",
      "invalid_presentation",
    );
    if (!decodedProof || !decodedInputs) {
      return reject(
        "invalid_presentation",
        "proof and public_inputs are required",
        "presentation_shape",
      );
    }
    proof = decodedProof;
    publicInputs = decodedInputs;

    commitment = toBytes(presentation.commitment, "commitment", "invalid_presentation");
    issuerPubKey = toBytes(presentation.issuer_pub_key, "issuer_pub_key", "invalid_presentation");
    merkleRoot = toBytes(presentation.merkle_root, "merkle_root", "invalid_presentation");
    nullifier = toBytes(presentation.nullifier, "nullifier", "invalid_presentation");

    if (presentation.vk_version !== undefined) {
      asNonNegativeInteger(presentation.vk_version, "vk_version", "invalid_presentation");
      if (presentation.vk_version < 1) {
        return reject(
          "invalid_presentation",
          "vk_version must be >= 1 (0 is the contract's 'no version' sentinel)",
          "presentation_shape",
        );
      }
    }
    if (presentation.min_threshold !== undefined) {
      asNonNegativeInteger(presentation.min_threshold, "min_threshold", "invalid_presentation");
    }
    if ((presentation.app_context === undefined) !== (nullifier === undefined)) {
      return reject(
        "invalid_presentation",
        "app_context and nullifier must be supplied together",
        "presentation_shape",
      );
    }
  } catch (err) {
    const error = err as OfflineVerificationError;
    return reject("invalid_presentation", error.message, "presentation_shape");
  }

  if (proof.length !== ULTRAHONK_PROOF_BYTES) {
    return reject(
      "invalid_presentation",
      `proof must be exactly ${ULTRAHONK_PROOF_BYTES} bytes (got ${proof.length})`,
      "proof_length",
    );
  }
  if (publicInputs.length === 0 || publicInputs.length % OFFLINE_FIELD_BYTES !== 0) {
    return reject(
      "invalid_presentation",
      `public_inputs must be a non-empty multiple of ${OFFLINE_FIELD_BYTES} bytes`,
      "public_inputs_shape",
    );
  }
  if (commitment && commitment.length !== OFFLINE_FIELD_BYTES) {
    return reject(
      "invalid_presentation",
      `commitment must be ${OFFLINE_FIELD_BYTES} bytes`,
      "presentation_shape",
    );
  }
  if (issuerPubKey && issuerPubKey.length !== OFFLINE_FIELD_BYTES * 2) {
    return reject(
      "invalid_presentation",
      `issuer_pub_key must be ${OFFLINE_FIELD_BYTES * 2} bytes`,
      "presentation_shape",
    );
  }
  if (merkleRoot && merkleRoot.length !== OFFLINE_FIELD_BYTES) {
    return reject(
      "invalid_presentation",
      `merkle_root must be ${OFFLINE_FIELD_BYTES} bytes`,
      "presentation_shape",
    );
  }
  if (nullifier && nullifier.length !== OFFLINE_FIELD_BYTES) {
    return reject(
      "invalid_presentation",
      `nullifier must be ${OFFLINE_FIELD_BYTES} bytes`,
      "presentation_shape",
    );
  }
  pass("presentation_shape");

  // ── 2. Snapshot freshness / network ─────────────────────────────────────
  const now = resolveNow(ctx.options.now);
  const maxAge = ctx.options.maxSnapshotAgeSeconds ?? DEFAULT_MAX_SNAPSHOT_AGE_SECONDS;
  const maxSkew = ctx.options.maxClockSkewSeconds ?? DEFAULT_MAX_CLOCK_SKEW_SECONDS;

  if (!(maxAge > 0) || !Number.isFinite(maxAge)) {
    return reject(
      "invalid_state_snapshot",
      "maxSnapshotAgeSeconds must be a positive finite number",
      "snapshot_freshness",
    );
  }

  const age = now - ctx.snapshot.capturedAt;
  if (age > maxAge) {
    return reject(
      "stale_state_snapshot",
      `state snapshot is ${age}s old (max ${maxAge}s); refresh the cache on a networked device`,
      "snapshot_freshness",
    );
  }
  if (-age > maxSkew) {
    return reject(
      "stale_state_snapshot",
      `state snapshot is dated ${-age}s in the future (max clock skew ${maxSkew}s)`,
      "snapshot_freshness",
    );
  }
  pass("snapshot_freshness", `snapshot age ${Math.max(age, 0)}s`);

  if (
    ctx.options.networkPassphrase &&
    ctx.snapshot.networkPassphrase &&
    ctx.options.networkPassphrase !== ctx.snapshot.networkPassphrase
  ) {
    return reject(
      "network_mismatch",
      `state snapshot is for a different network (${ctx.snapshot.networkPassphrase})`,
      "snapshot_network",
    );
  }
  pass("snapshot_network");

  // ── 3. Verifier key selection ────────────────────────────────────────────
  const key = selectVerifierKey(presentation, ctx);
  if (!key) {
    return reject(
      "missing_verifier_key",
      presentation.vk_version !== undefined
        ? `no cached verifier key for ${presentation.credential_type} vk_version ${presentation.vk_version}`
        : `no cached, non-deprecated verifier key for ${presentation.credential_type}`,
      "verifier_key",
    );
  }
  if (key.deprecated && !ctx.options.allowDeprecatedKeys) {
    return reject(
      "deprecated_verifier_key",
      `cached verifier key for ${key.credentialType} vk_version ${key.vkVersion} is deprecated`,
      "verifier_key",
    );
  }
  pass("verifier_key", `${key.credentialType} vk_version ${key.vkVersion}`);

  // ── 4. Cached claim record ───────────────────────────────────────────────
  const holder = presentation.holder.trim();
  const claim = findClaim(ctx.snapshot, holder, presentation.credential_type);
  if (!claim) {
    return reject(
      "no_proof_record",
      `state snapshot has no ${presentation.credential_type} record for the holder`,
      "claim_record",
    );
  }
  pass("claim_record", `recorded at ${claim.verifiedAt}`);

  if (claim.vkVersion !== undefined && claim.vkVersion !== key.vkVersion) {
    return reject(
      "vk_version_mismatch",
      `holder's record was verified with vk_version ${claim.vkVersion}, presentation uses ${key.vkVersion}`,
      "vk_version",
    );
  }
  pass("vk_version");

  if (claim.revoked) {
    return reject(
      "revoked",
      `credential was revoked${claim.reasonCode ? ` (${claim.reasonCode})` : ""}`,
      "revocation",
    );
  }
  pass("revocation");

  if (claim.expiry > 0 && claim.expiry <= now) {
    return reject("expired", `credential expired at ${claim.expiry} (now ${now})`, "expiry");
  }
  pass("expiry", claim.expiry === 0 ? "no expiry" : `expires at ${claim.expiry}`);

  // ── 5. Commitment binding ────────────────────────────────────────────────
  const claimCommitment = claim.commitment;
  const presentationCommitment = commitment ? toHex(commitment) : undefined;
  if (claimCommitment && presentationCommitment && claimCommitment !== presentationCommitment) {
    return reject(
      "commitment_mismatch",
      "presentation commitment does not match the cached claim record",
      "commitment",
    );
  }
  const boundCommitment = presentationCommitment ?? claimCommitment;
  if (boundCommitment) {
    const boundBytes = toBytes(boundCommitment, "commitment", "invalid_state_snapshot");
    if (boundBytes && !containsField(splitFields(publicInputs), boundBytes)) {
      return reject(
        "public_inputs_mismatch",
        "commitment is not among the proof's public inputs",
        "commitment",
      );
    }
    if (ctx.snapshot.revokedCommitments.has(boundCommitment)) {
      return reject(
        "revoked",
        "commitment appears in the snapshot's revoked-commitment list",
        "revocation",
      );
    }
  }
  pass("commitment", boundCommitment ? `bound ${boundCommitment.slice(0, 12)}…` : "not bound");

  // ── 6. Issuer binding and trust ─────────────────────────────────────────
  const claimIssuer = claim.issuer;
  const effectiveIssuer = presentation.issuer_id?.trim() || claimIssuer;
  const trusted = ctx.options.trustedIssuers;
  if (trusted && trusted.length > 0) {
    if (!effectiveIssuer) {
      return reject(
        "issuer_untrusted",
        "presentation does not identify an issuer and trustedIssuers is configured",
        "issuer",
      );
    }
    if (!trusted.includes(effectiveIssuer)) {
      return reject("issuer_untrusted", `issuer ${effectiveIssuer} is not trusted`, "issuer");
    }
  }
  if (presentation.issuer_id && claimIssuer && presentation.issuer_id.trim() !== claimIssuer) {
    return reject(
      "issuer_untrusted",
      "presentation issuer does not match the cached claim record",
      "issuer",
    );
  }

  const presentationIssuerKey = issuerPubKey ? toHex(issuerPubKey) : undefined;
  const claimIssuerKey = claim.issuerPubKey;
  if (presentationIssuerKey && claimIssuerKey && presentationIssuerKey !== claimIssuerKey) {
    return reject(
      "issuer_key_mismatch",
      "presentation issuer key does not match the cached claim record",
      "issuer_key",
    );
  }
  const boundIssuerKey = presentationIssuerKey ?? claimIssuerKey;

  if (effectiveIssuer && ctx.snapshot.issuerKeys.size > 0) {
    const accepted = ctx.snapshot.issuerKeys.get(effectiveIssuer);
    if (!accepted || accepted.size === 0) {
      return reject(
        "issuer_key_missing",
        `state snapshot has no accepted issuer key for ${effectiveIssuer}`,
        "issuer_key",
      );
    }
    if (!boundIssuerKey) {
      return reject(
        "issuer_key_missing",
        "presentation does not bind an issuer public key, which this snapshot requires",
        "issuer_key",
      );
    }
    if (!accepted.has(boundIssuerKey)) {
      return reject(
        "issuer_key_mismatch",
        `issuer key is not accepted for ${effectiveIssuer}`,
        "issuer_key",
      );
    }
  } else if (trusted && trusted.length > 0 && !boundIssuerKey) {
    return reject(
      "issuer_key_missing",
      "trustedIssuers is configured but the presentation binds no issuer public key",
      "issuer_key",
    );
  }

  if (boundIssuerKey) {
    const keyBytes = toBytes(boundIssuerKey, "issuer_pub_key", "invalid_state_snapshot");
    if (keyBytes) {
      if (!containsBytes(splitFields(publicInputs), keyBytes)) {
        return reject(
          "public_inputs_mismatch",
          "issuer public key is not among the proof's public inputs",
          "issuer_key",
        );
      }
    }
  }
  pass("issuer", effectiveIssuer ?? "any issuer");
  pass("issuer_key", boundIssuerKey ? `${boundIssuerKey.slice(0, 12)}…` : "not bound");

  // ── 7. Merkle root (when the deployment uses one) ───────────────────────
  if (merkleRoot) {
    const presentedRoot = toHex(merkleRoot);
    if (ctx.snapshot.merkleRoot && ctx.snapshot.merkleRoot !== presentedRoot) {
      return reject(
        "merkle_root_mismatch",
        "presentation Merkle root does not match the cached state snapshot",
        "merkle_root",
      );
    }
    if (!containsField(splitFields(publicInputs), merkleRoot)) {
      return reject(
        "public_inputs_mismatch",
        "Merkle root is not among the proof's public inputs",
        "merkle_root",
      );
    }
  }
  pass("merkle_root", merkleRoot ? "matched" : "not used");

  // ── 8. Threshold ────────────────────────────────────────────────────────
  const requiredThreshold =
    presentation.min_threshold ?? ctx.options.minThresholds?.[presentation.credential_type] ?? 0;
  if (requiredThreshold > 0) {
    if (claim.threshold === undefined) {
      return reject(
        "threshold_not_met",
        `credential carries no threshold, but ${requiredThreshold} is required`,
        "threshold",
      );
    }
    if (claim.threshold < requiredThreshold) {
      return reject(
        "threshold_not_met",
        `credential threshold ${claim.threshold} is below the required ${requiredThreshold}`,
        "threshold",
      );
    }
  }
  pass("threshold", requiredThreshold > 0 ? `>= ${requiredThreshold}` : "not required");

  // ── 9. Nullifier replay ─────────────────────────────────────────────────
  if (nullifier && presentation.app_context) {
    let appContextHex: string;
    try {
      appContextHex = normalizeHex(presentation.app_context, "app_context", OFFLINE_FIELD_BYTES);
    } catch (err) {
      return reject("invalid_presentation", (err as OfflineVerificationError).message, "nullifier");
    }
    const nullifierHex = toHex(nullifier);
    if (ctx.snapshot.nullifiers.has(`${appContextHex}|${nullifierHex}`)) {
      return reject(
        "nullifier_reused",
        "nullifier has already been consumed in this application context",
        "nullifier",
      );
    }
  }
  pass("nullifier", nullifier ? "unused" : "not presented");

  // ── 10. Local proof verification ────────────────────────────────────────
  try {
    const proofOk = await ctx.proofVerifier({
      verifierKey: key.vk,
      proof,
      publicInputs,
      credentialType: key.credentialType,
      vkVersion: key.vkVersion,
      circuitBytecode: key.circuitBytecode,
    });
    if (!proofOk) {
      return reject(
        "proof_invalid",
        "UltraHonk proof did not verify against the cached verifier key",
        "proof",
      );
    }
  } catch (err) {
    const error = err as OfflineVerificationError;
    if (error instanceof OfflineVerificationError) {
      return reject(error.code, error.message, "proof");
    }
    return reject(
      "proof_backend_error",
      `local proof verifier failed: ${err instanceof Error ? err.message : String(err)}`,
      "proof",
    );
  }
  pass("proof");

  return {
    valid: true,
    code: "valid",
    credentialType: presentation.credential_type,
    vkVersion: key.vkVersion,
    holder,
    issuerId: effectiveIssuer,
    commitment: boundCommitment,
    verifiedAt: claim.verifiedAt,
    expiry: claim.expiry,
    snapshotLedgerSequence: ctx.snapshot.ledgerSequence,
    checks,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an offline verifier from cached verifier keys and a state snapshot.
 *
 * Construction validates the cache and throws {@link OfflineVerificationError}
 * for malformed configuration — a terminal should refuse to start rather than
 * verify against a corrupt cache. Per-presentation failures are returned, not
 * thrown.
 */
export function createOfflineVerifier(options: OfflineVerifierOptions): OfflineVerifier {
  if (!options || typeof options !== "object") {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      "offline verifier options are required",
    );
  }

  const snapshot = normalizeSnapshot(options.stateSnapshot);
  const keys = normalizeVerifierKeys(options.verifierKeys);

  if (options.trustedIssuers !== undefined && !Array.isArray(options.trustedIssuers)) {
    throw new OfflineVerificationError(
      "invalid_state_snapshot",
      "trustedIssuers must be an array of issuer addresses",
    );
  }
  if (options.maxSnapshotAgeSeconds !== undefined) {
    if (
      typeof options.maxSnapshotAgeSeconds !== "number" ||
      !Number.isFinite(options.maxSnapshotAgeSeconds) ||
      options.maxSnapshotAgeSeconds <= 0
    ) {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        "maxSnapshotAgeSeconds must be a positive finite number",
      );
    }
  }
  if (options.minThresholds !== undefined) {
    const record = asRecord(options.minThresholds);
    if (!record) {
      throw new OfflineVerificationError(
        "invalid_state_snapshot",
        "minThresholds must be an object keyed by credential type",
      );
    }
    for (const [type, threshold] of Object.entries(record)) {
      if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 0) {
        throw new OfflineVerificationError(
          "invalid_state_snapshot",
          `minThresholds["${type}"] must be a non-negative integer`,
        );
      }
    }
  }

  const ctx: VerificationContext = {
    options,
    snapshot,
    keys,
    proofVerifier: options.proofVerifier ?? defaultProofVerifier,
  };

  const verify = async (presentation: OfflinePresentation): Promise<OfflineVerificationResult> => {
    try {
      return await runVerification(presentation, ctx);
    } catch (err) {
      if (err instanceof OfflineVerificationError) {
        return fail(err.code, err.message, []);
      }
      return fail(
        "internal_error",
        `offline verification failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
        [],
      );
    }
  };

  return {
    verify,
    async verifyAll(presentations) {
      if (!Array.isArray(presentations)) {
        return [fail("invalid_presentation", "presentations must be an array", [])];
      }
      return Promise.all(presentations.map((presentation) => verify(presentation)));
    },
  };
}

/**
 * One-shot convenience wrapper around {@link createOfflineVerifier}. Builds a
 * verifier for every call, so prefer the factory when verifying more than one
 * presentation against the same cache.
 */
export function verifyOfflinePresentation(
  presentation: OfflinePresentation,
  options: OfflineVerifierOptions,
): Promise<OfflineVerificationResult> {
  return createOfflineVerifier(options).verify(presentation);
}
