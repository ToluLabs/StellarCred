import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  STELLAR_PRIMARY_DERIVATION_PATH,
  deriveStellarKeypairFromMnemonic,
  deriveStellarKeypairFromSeed,
  getStellarDerivationPath,
  isValidStellarMnemonic,
} from "./key-derivation";
import { deriveStellarKeypairFromMnemonic as deriveFromSdkBarrel } from "./index";

const HARDENED_OFFSET = 0x80000000;
const SEP5_MNEMONIC_12 = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const SEP5_MNEMONIC_24 =
  "bench hurt jump file august wise shallow faculty impulse spring exact slush thunder author capable act festival slice deposit sauce coconut afford frown better";
const ABANDON_MNEMONIC_12 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ABANDON_MNEMONIC_24 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

interface WipeRecord {
  readonly before: string;
  readonly buffer: Uint8Array;
}

function trackWholeBufferWipes<T>(run: () => T): { result: T; records: WipeRecord[] } {
  const originalFill = Uint8Array.prototype.fill;
  const records: WipeRecord[] = [];
  const fillSpy = vi.spyOn(Uint8Array.prototype, "fill").mockImplementation(function (
    this: Uint8Array,
    value: number,
    start?: number,
    end?: number,
  ): Uint8Array {
    if (value === 0 && start === undefined && end === undefined) {
      records.push({ before: bytesToHex(this), buffer: this });
    }
    return originalFill.call(this, value, start, end);
  });

  try {
    return { result: run(), records };
  } finally {
    fillSpy.mockRestore();
  }
}

function expectWiped(records: readonly WipeRecord[], expectedBefore: string): void {
  const record = records.find(({ before }) => before === expectedBefore);
  expect(record, `expected ${expectedBefore} to be wiped`).toBeDefined();
  expect(record?.buffer.every((byte) => byte === 0)).toBe(true);
}

describe("SLIP-0010 Ed25519 derivation", () => {
  // Official SatoshiLabs SLIP-0010 test vector 1 for Ed25519:
  // https://github.com/satoshilabs/slips/blob/master/slip-0010.md#test-vector-1-for-ed25519
  const vectors = [
    {
      path: "m",
      privateKey: "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
      publicKey: "a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed",
    },
    {
      path: "m/0'",
      privateKey: "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
      publicKey: "8c8a13df77a28f3445213a0f432fde644acaa215fc72dcdf300d5efaa85d350c",
    },
    {
      path: "m/0'/1'",
      privateKey: "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
      publicKey: "1932a5270f335bed617d5b935c80aedb1a35bd9fc1e31acafd5372c30f5c1187",
    },
    {
      path: "m/0'/1'/2'",
      privateKey: "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9",
      publicKey: "ae98736566d30ed0e9d2f4486a64bc95740d89c7db33f52121f8ea8f76ff0fc1",
    },
  ] as const;

  for (const vector of vectors) {
    it(`matches the published vector at ${vector.path}`, () => {
      const seed = hexToBytes("000102030405060708090a0b0c0d0e0f");
      const result = deriveStellarKeypairFromSeed(seed, vector.path);

      expect(bytesToHex(StrKey.decodeEd25519SecretSeed(result.secretKey))).toBe(vector.privateKey);
      expect(bytesToHex(StrKey.decodeEd25519PublicKey(result.publicKey))).toBe(vector.publicKey);
      expect(result.path).toBe(vector.path);
      expect(seed.every((byte) => byte === 0)).toBe(true);
    });
  }

  it.each(["m/44/148'/0'", "m/44'/148'/0", "44'/148'/0'", "m/-1'", "m/2147483648'"])(
    "rejects the invalid or non-hardened path %s and still wipes the seed",
    (path) => {
      const seed = hexToBytes("000102030405060708090a0b0c0d0e0f");

      expect(() => deriveStellarKeypairFromSeed(seed, path)).toThrow();
      expect(seed.every((byte) => byte === 0)).toBe(true);
    },
  );

  it("rejects an invalid seed length and wipes the supplied buffer", () => {
    const seed = new Uint8Array(15).fill(7);

    expect(() => deriveStellarKeypairFromSeed(seed)).toThrow(
      "SLIP-0010 seed must contain 16 to 64 bytes",
    );
    expect(seed.every((byte) => byte === 0)).toBe(true);
  });

  it("wipes every private key and chain code in the official derivation chain", () => {
    const seed = hexToBytes("000102030405060708090a0b0c0d0e0f");
    const { records } = trackWholeBufferWipes(() =>
      deriveStellarKeypairFromSeed(seed, "m/0'/1'/2'"),
    );

    for (const privateKey of [
      "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
      "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
      "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
      "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9",
    ]) {
      expectWiped(records, privateKey);
    }
    for (const chainCode of [
      "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb",
      "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69",
      "a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14",
      "2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c",
    ]) {
      expectWiped(records, chainCode);
    }
    expectWiped(records, "000102030405060708090a0b0c0d0e0f");
  });
});

describe("SEP-5 mnemonic derivation", () => {
  // Official Stellar SEP-0005 vectors:
  // https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md#test-cases
  const vectors = [
    {
      name: "12 words",
      mnemonic: SEP5_MNEMONIC_12,
      publicKey: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
      secretKey: "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN",
    },
    {
      name: "24 words",
      mnemonic: SEP5_MNEMONIC_24,
      publicKey: "GC3MMSXBWHL6CPOAVERSJITX7BH76YU252WGLUOM5CJX3E7UCYZBTPJQ",
      secretKey: "SAEWIVK3VLNEJ3WEJRZXQGDAS5NVG2BYSYDFRSH4GKVTS5RXNVED5AX7",
    },
    {
      name: "12 words with zero entropy",
      mnemonic: ABANDON_MNEMONIC_12,
      publicKey: "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX",
      secretKey: "SBUV3MRWKNS6AYKZ6E6MOUVF2OYMON3MIUASWL3JLY5E3ISDJFELYBRZ",
    },
    {
      name: "24 words with a passphrase",
      mnemonic:
        "cable spray genius state float twenty onion head street palace net private method loan turn phrase state blanket interest dry amazing dress blast tube",
      passphrase: "p4ssphr4se",
      publicKey: "GDAHPZ2NSYIIHZXM56Y36SBVTV5QKFIZGYMMBHOU53ETUSWTP62B63EQ",
      secretKey: "SAFWTGXVS7ELMNCXELFWCFZOPMHUZ5LXNBGUVRCY3FHLFPXK4QPXYP2X",
    },
  ] as const;

  for (const vector of vectors) {
    it(`matches the official primary-account vector for ${vector.name}`, () => {
      const result = deriveStellarKeypairFromMnemonic(vector.mnemonic, {
        passphrase: "passphrase" in vector ? vector.passphrase : undefined,
      });

      expect(result).toEqual({
        publicKey: vector.publicKey,
        secretKey: vector.secretKey,
        path: STELLAR_PRIMARY_DERIVATION_PATH,
      });
    });
  }

  it("derives deterministic, distinct holder identities by account index", () => {
    const primary = deriveStellarKeypairFromMnemonic(SEP5_MNEMONIC_12);
    const secondary = deriveStellarKeypairFromMnemonic(SEP5_MNEMONIC_12, { accountIndex: 1 });

    expect(primary.publicKey).not.toBe(secondary.publicKey);
    expect(secondary).toEqual({
      publicKey: "GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX",
      secretKey: "SCEPFFWGAG5P2VX5DHIYK3XEMZYLTYWIPWYEKXFHSK25RVMIUNJ7CTIS",
      path: "m/44'/148'/1'",
    });
  });
});

describe("BIP-39 conformance and secret handling", () => {
  // Official vectors maintained by Trezor use the passphrase "TREZOR":
  // https://github.com/trezor/python-mnemonic/blob/master/vectors.json
  it.each([
    {
      name: "128-bit entropy",
      mnemonic: ABANDON_MNEMONIC_12,
      seed: "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04",
    },
    {
      name: "256-bit entropy",
      mnemonic: ABANDON_MNEMONIC_24,
      seed: "bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8",
    },
  ])("matches and wipes the published $name seed", ({ mnemonic, seed }) => {
    const { result, records } = trackWholeBufferWipes(() =>
      deriveStellarKeypairFromMnemonic(mnemonic, { passphrase: "TREZOR" }),
    );

    expect(StrKey.isValidEd25519PublicKey(result.publicKey)).toBe(true);
    expectWiped(records, seed);
  });

  it("wipes the BIP-39 seed and final private/public key buffers", () => {
    const bip39Seed =
      "e4a5a632e70943ae7f07659df1332160937fad82587216a4c64315a0fb39497ee4a01f76ddab4cba68147977f3a147b6ad584c41808e8238a07f6cc4b582f186";
    const { result, records } = trackWholeBufferWipes(() =>
      deriveStellarKeypairFromMnemonic(SEP5_MNEMONIC_12),
    );

    expectWiped(records, bip39Seed);
    expectWiped(records, bytesToHex(StrKey.decodeEd25519SecretSeed(result.secretKey)));
    expectWiped(records, bytesToHex(StrKey.decodeEd25519PublicKey(result.publicKey)));
  });

  it("never writes mnemonic or derived secrets to the console", () => {
    const spies = ["debug", "error", "info", "log", "warn"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined),
    );

    try {
      deriveStellarKeypairFromMnemonic(SEP5_MNEMONIC_12);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("validation and path helpers", () => {
  it("exports the derivation helper from the public SDK barrel", () => {
    expect(deriveFromSdkBarrel).toBe(deriveStellarKeypairFromMnemonic);
  });

  it("validates mnemonic words and checksum without exposing input in errors", () => {
    expect(isValidStellarMnemonic(SEP5_MNEMONIC_12)).toBe(true);
    expect(isValidStellarMnemonic(`${SEP5_MNEMONIC_12} wrong`)).toBe(false);

    const invalidMnemonic = "abandon ".repeat(12).trim();
    expect(() => deriveStellarKeypairFromMnemonic(invalidMnemonic)).toThrow(
      "Invalid English BIP-39 mnemonic",
    );
  });

  it("normalizes harmless surrounding and repeated whitespace", () => {
    const paddedMnemonic = `  ${SEP5_MNEMONIC_12.replaceAll(" ", "   ")}  `;
    expect(deriveStellarKeypairFromMnemonic(paddedMnemonic).publicKey).toBe(
      "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
    );
  });

  it("builds canonical SEP-5 paths and rejects invalid account indexes", () => {
    expect(getStellarDerivationPath()).toBe(STELLAR_PRIMARY_DERIVATION_PATH);
    expect(getStellarDerivationPath(7)).toBe("m/44'/148'/7'");

    for (const index of [-1, 1.5, Number.NaN, HARDENED_OFFSET]) {
      expect(() => getStellarDerivationPath(index)).toThrow(RangeError);
    }
  });
});
