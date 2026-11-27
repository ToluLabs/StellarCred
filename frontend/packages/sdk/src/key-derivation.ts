import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";
import { StrKey } from "@stellar/stellar-sdk";

const HARDENED_OFFSET = 0x80000000;
const MAX_UNHARDENED_INDEX = HARDENED_OFFSET - 1;
const MIN_SLIP10_SEED_BYTES = 16;
const MAX_SLIP10_SEED_BYTES = 64;
const ED25519_SEED_KEY = new TextEncoder().encode("ed25519 seed");

/** SEP-5's primary Stellar account path. */
export const STELLAR_PRIMARY_DERIVATION_PATH = "m/44'/148'/0'";

export interface DerivedStellarKeypair {
  /** Stellar G-address. */
  readonly publicKey: string;
  /** Stellar S-address. This is sensitive and must never be logged. */
  readonly secretKey: string;
  /** Hardened SLIP-0010 path used for the derivation. */
  readonly path: string;
}

export interface StellarMnemonicDerivationOptions {
  /** Optional BIP-39 passphrase. */
  readonly passphrase?: string;
  /** SEP-5 account index. Defaults to the primary account (0). */
  readonly accountIndex?: number;
}

function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/gu, " ");
}

/** Validate an English BIP-39 mnemonic, including its checksum. */
export function isValidStellarMnemonic(mnemonic: string): boolean {
  if (typeof mnemonic !== "string") return false;
  return validateMnemonic(normalizeMnemonic(mnemonic), englishWordlist);
}

/** Build the SEP-5 path `m/44'/148'/x'` for a Stellar account index. */
export function getStellarDerivationPath(accountIndex = 0): string {
  if (
    !Number.isSafeInteger(accountIndex) ||
    accountIndex < 0 ||
    accountIndex > MAX_UNHARDENED_INDEX
  ) {
    throw new RangeError("Stellar account index must be an integer from 0 to 2147483647");
  }
  return `m/44'/148'/${accountIndex}'`;
}

/**
 * Derive a SEP-5 Stellar keypair from an English BIP-39 mnemonic.
 *
 * Mutable BIP-39 seed and derived-key buffers are overwritten before this
 * function returns, including when derivation throws. The returned S-address
 * is an immutable JavaScript string and therefore cannot be wiped by the SDK.
 */
export function deriveStellarKeypairFromMnemonic(
  mnemonic: string,
  options: StellarMnemonicDerivationOptions = {},
): DerivedStellarKeypair {
  if (typeof mnemonic !== "string") {
    throw new TypeError("BIP-39 mnemonic must be a string");
  }
  if (options.passphrase !== undefined && typeof options.passphrase !== "string") {
    throw new TypeError("BIP-39 passphrase must be a string");
  }

  const normalizedMnemonic = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalizedMnemonic, englishWordlist)) {
    throw new Error("Invalid English BIP-39 mnemonic");
  }

  const path = getStellarDerivationPath(options.accountIndex ?? 0);
  const seed = mnemonicToSeedSync(normalizedMnemonic, options.passphrase ?? "");
  return deriveStellarKeypairFromSeed(seed, path);
}

/**
 * Derive a Stellar-encoded Ed25519 keypair from a SLIP-0010 seed and hardened path.
 *
 * @remarks
 * This function **consumes** `seed`: the supplied buffer is overwritten with
 * zeroes before return, on both success and failure. Pass a copy if the caller
 * must retain the seed. Ed25519 SLIP-0010 supports hardened path components only.
 */
export function deriveStellarKeypairFromSeed(
  seed: Uint8Array,
  path = STELLAR_PRIMARY_DERIVATION_PATH,
): DerivedStellarKeypair {
  if (!(seed instanceof Uint8Array)) {
    throw new TypeError("SLIP-0010 seed must be a Uint8Array");
  }

  let privateKey: Uint8Array | undefined;
  let publicKey: Uint8Array | undefined;

  try {
    if (seed.length < MIN_SLIP10_SEED_BYTES || seed.length > MAX_SLIP10_SEED_BYTES) {
      throw new RangeError("SLIP-0010 seed must contain 16 to 64 bytes");
    }

    const indexes = parseHardenedPath(path);
    privateKey = deriveSlip10Ed25519PrivateKey(seed, indexes);
    publicKey = ed25519.getPublicKey(privateKey);

    return {
      // stellar-sdk's declarations narrow these inputs to Node Buffer even
      // though StrKey accepts Uint8Array. Keep the original arrays so there is
      // no additional key copy to wipe.
      publicKey: StrKey.encodeEd25519PublicKey(publicKey as Buffer),
      secretKey: StrKey.encodeEd25519SecretSeed(privateKey as Buffer),
      path,
    };
  } finally {
    publicKey?.fill(0);
    privateKey?.fill(0);
    seed.fill(0);
  }
}

function parseHardenedPath(path: string): number[] {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("SLIP-0010 path must be a non-empty string");
  }
  if (path === "m") return [];
  if (!path.startsWith("m/")) {
    throw new Error("SLIP-0010 path must start with m/");
  }

  return path
    .slice(2)
    .split("/")
    .map((component) => {
      if (!/^(0|[1-9]\d*)'$/.test(component)) {
        throw new Error("Ed25519 SLIP-0010 paths must contain hardened indexes only");
      }

      const index = Number(component.slice(0, -1));
      if (!Number.isSafeInteger(index) || index > MAX_UNHARDENED_INDEX) {
        throw new RangeError("SLIP-0010 path index must be from 0 to 2147483647");
      }
      return index;
    });
}

function deriveSlip10Ed25519PrivateKey(seed: Uint8Array, indexes: readonly number[]): Uint8Array {
  let privateKey: Uint8Array | undefined;
  let chainCode: Uint8Array | undefined;

  try {
    ({ privateKey, chainCode } = splitHmac(ED25519_SEED_KEY, seed));

    for (const index of indexes) {
      const data = new Uint8Array(37);
      data[0] = 0;
      data.set(privateKey, 1);
      new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(
        33,
        index + HARDENED_OFFSET,
        false,
      );

      let child: { privateKey: Uint8Array; chainCode: Uint8Array };
      try {
        child = splitHmac(chainCode, data);
      } finally {
        data.fill(0);
      }

      privateKey.fill(0);
      chainCode.fill(0);
      privateKey = child.privateKey;
      chainCode = child.chainCode;
    }

    const result = privateKey;
    privateKey = undefined;
    return result;
  } finally {
    privateKey?.fill(0);
    chainCode?.fill(0);
  }
}

function splitHmac(
  key: Uint8Array,
  data: Uint8Array,
): { privateKey: Uint8Array; chainCode: Uint8Array } {
  const digest = hmac(sha512, key, data);
  let privateKey: Uint8Array | undefined;
  let chainCode: Uint8Array | undefined;

  try {
    privateKey = digest.slice(0, 32);
    chainCode = digest.slice(32, 64);
    return { privateKey, chainCode };
  } catch (error) {
    privateKey?.fill(0);
    chainCode?.fill(0);
    throw error;
  } finally {
    digest.fill(0);
  }
}
