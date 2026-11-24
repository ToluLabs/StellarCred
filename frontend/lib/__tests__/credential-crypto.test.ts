import { describe, it, expect } from "vitest";
import {
  DecryptionError,
  ENVELOPE_VERSION,
  PBKDF2_ITERATIONS,
  LEGACY_PBKDF2_ITERATIONS,
  SALT_BYTES,
  IV_BYTES,
  KEY_BYTES,
  computeKeyFingerprint,
  decodeB64,
  derivePassphraseKey,
  encodeB64Url,
  encryptWithPassphrase,
  decryptWithPassphrase,
  generateCredentialKey,
  importCredentialKey,
  isCredentialEnvelope,
  openWithKey,
  openWithPassphrase,
  resolveEnvelopeIterations,
  sealWithKey,
  sealWithPassphrase,
  toHex,
  type CredentialEnvelope,
} from "../credential-crypto";

// ---- independent reference implementations of the legacy formats -------------
// These replicate the pre-#547 wire formats byte-for-byte so the tests prove
// the consolidated module still opens historical artifacts. Kept separate from
// the module's own helpers on purpose.

function legacyToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function legacyDeriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Builds a version-1/2 backup JSON exactly as backup.ts wrote it. */
async function makeLegacyBackupJson(
  plaintext: string,
  passphrase: string,
  opts: { version: 1 | 2; iterations: number },
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await legacyDeriveKey(passphrase, salt, opts.iterations);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const env: Record<string, unknown> = {
    version: opts.version,
    salt: legacyToBase64(salt),
    iv: legacyToBase64(iv),
    ciphertext: legacyToBase64(ct),
  };
  if (opts.version === 2) env.iterations = opts.iterations;
  return JSON.stringify(env);
}

/** Builds a compact transfer code exactly as the old lib/crypto.ts did. */
async function makeLegacyTransferCode(
  plaintext: string,
  passphrase: string,
  iterations: number,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await legacyDeriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const envelope = new Uint8Array(1 + SALT_BYTES + IV_BYTES + ct.length);
  envelope[0] = 1;
  envelope.set(salt, 1);
  envelope.set(iv, 1 + SALT_BYTES);
  envelope.set(ct, 1 + SALT_BYTES + IV_BYTES);
  return encodeB64Url(envelope);
}

const PASS = "corr3ct-h0rse-b4ttery-st4ple";

describe("credential-crypto — parameters", () => {
  it("exposes the single scheme's constants", () => {
    expect(KEY_BYTES).toBe(32);
    expect(SALT_BYTES).toBe(16);
    expect(IV_BYTES).toBe(12);
    expect(ENVELOPE_VERSION).toBe(3);
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(LEGACY_PBKDF2_ITERATIONS).toBe(100_000);
  });
});

describe("credential-crypto — base64 helpers", () => {
  it("round-trips bytes through base64url", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(37));
    const enc = encodeB64Url(bytes);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(toHex(decodeB64(enc))).toBe(toHex(bytes));
  });

  it("decodeB64 accepts standard, url-safe and unpadded input", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const std = btoa(String.fromCharCode(...bytes));
    const url = encodeB64Url(bytes);
    expect(toHex(decodeB64(std))).toBe(toHex(bytes));
    expect(toHex(decodeB64(url))).toBe(toHex(bytes));
  });
});

describe("credential-crypto — envelope version resolution", () => {
  it("maps each version to the iteration cost that wrote it", () => {
    expect(resolveEnvelopeIterations({ version: 1, iv: "", ciphertext: "" })).toBe(
      LEGACY_PBKDF2_ITERATIONS,
    );
    expect(
      resolveEnvelopeIterations({ version: 2, iterations: 1234, iv: "", ciphertext: "" }),
    ).toBe(1234);
    expect(resolveEnvelopeIterations({ version: 2, iv: "", ciphertext: "" })).toBe(
      LEGACY_PBKDF2_ITERATIONS,
    );
    expect(
      resolveEnvelopeIterations({ version: 3, iterations: 9999, iv: "", ciphertext: "" }),
    ).toBe(9999);
    expect(resolveEnvelopeIterations({ version: 3, iv: "", ciphertext: "" })).toBe(
      PBKDF2_ITERATIONS,
    );
  });

  it("throws on an unknown version", () => {
    expect(() => resolveEnvelopeIterations({ version: 99, iv: "", ciphertext: "" })).toThrow(
      DecryptionError,
    );
  });

  it("v1 never trusts a stored iterations field (cost stays the legacy value)", () => {
    expect(
      resolveEnvelopeIterations({ version: 1, iterations: 1, iv: "", ciphertext: "" }),
    ).toBe(LEGACY_PBKDF2_ITERATIONS);
  });
});

describe("credential-crypto — isCredentialEnvelope", () => {
  it("recognizes envelopes of known versions and rejects junk", () => {
    expect(isCredentialEnvelope({ version: 1, salt: "a", iv: "b", ciphertext: "c" })).toBe(true);
    expect(isCredentialEnvelope({ version: 3, iv: "b", ciphertext: "c" })).toBe(true);
    expect(isCredentialEnvelope({ version: 4, iv: "b", ciphertext: "c" })).toBe(false);
    expect(isCredentialEnvelope({ version: 1, iv: "b" })).toBe(false);
    expect(isCredentialEnvelope(null)).toBe(false);
    expect(isCredentialEnvelope("nope")).toBe(false);
  });
});

describe("credential-crypto — passphrase seal / open (v3)", () => {
  it("round-trips plaintext", async () => {
    const sealed = await sealWithPassphrase("secret-value", PASS);
    expect(sealed.version).toBe(ENVELOPE_VERSION);
    expect(sealed.kdf).toBe("PBKDF2-SHA256");
    expect(sealed.iterations).toBe(PBKDF2_ITERATIONS);
    expect(await openWithPassphrase(sealed, PASS)).toBe("secret-value");
  });

  it("does not leak plaintext and randomizes salt/iv", async () => {
    const a = await sealWithPassphrase("hello world", PASS);
    const b = await sealWithPassphrase("hello world", PASS);
    expect(a.ciphertext).not.toContain("hello");
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });

  it("rejects a wrong passphrase", async () => {
    const sealed = await sealWithPassphrase("data", PASS);
    await expect(openWithPassphrase(sealed, "wrong")).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects a tampered ciphertext", async () => {
    const sealed = await sealWithPassphrase("data", PASS);
    const first = sealed.ciphertext[0];
    const flipped: CredentialEnvelope = {
      ...sealed,
      ciphertext: (first === "A" ? "B" : "A") + sealed.ciphertext.slice(1),
    };
    await expect(openWithPassphrase(flipped, PASS)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects a missing salt", async () => {
    const sealed = await sealWithPassphrase("data", PASS);
    const noSalt: CredentialEnvelope = { ...sealed, salt: undefined };
    await expect(openWithPassphrase(noSalt, PASS)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("refuses to open a RAW envelope with a passphrase", async () => {
    const key = await importCredentialKey(generateCredentialKey());
    const sealed = await sealWithKey("data", key, { kdf: "RAW" });
    await expect(openWithPassphrase(sealed, PASS)).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe("credential-crypto — key seal / open (RAW kdf, guardian path)", () => {
  it("round-trips with a generated key", async () => {
    const raw = generateCredentialKey();
    expect(raw).toHaveLength(KEY_BYTES);
    const key = await importCredentialKey(raw);
    const sealed = await sealWithKey("credential json", key, { kdf: "RAW" });
    expect(sealed.kdf).toBe("RAW");
    expect(sealed.salt).toBeUndefined();
    const reopened = await openWithKey(sealed, await importCredentialKey(raw, ["decrypt"]));
    expect(reopened).toBe("credential json");
  });

  it("rejects a wrong key", async () => {
    const key = await importCredentialKey(generateCredentialKey());
    const sealed = await sealWithKey("x", key, { kdf: "RAW" });
    const other = await importCredentialKey(generateCredentialKey(), ["decrypt"]);
    await expect(openWithKey(sealed, other)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("annotates a PBKDF2 salt/iterations when sealing with a pre-derived key (at-rest path)", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const key = await derivePassphraseKey(PASS, salt);
    const sealed = await sealWithKey("payload", key, {
      kdf: "PBKDF2-SHA256",
      salt,
      iterations: PBKDF2_ITERATIONS,
    });
    expect(sealed.kdf).toBe("PBKDF2-SHA256");
    expect(sealed.iterations).toBe(PBKDF2_ITERATIONS);
    expect(sealed.salt).toBe(encodeB64Url(salt));
    expect(await openWithPassphrase(sealed, PASS)).toBe("payload");
  });
});

describe("credential-crypto — key fingerprint", () => {
  it("is stable for the same key and differs across keys", async () => {
    const raw = generateCredentialKey();
    const fp1 = await computeKeyFingerprint(raw);
    const fp2 = await computeKeyFingerprint(raw);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
    expect(await computeKeyFingerprint(generateCredentialKey())).not.toBe(fp1);
  });
});

describe("credential-crypto — backward compatibility with legacy backups", () => {
  it("opens a version-1 backup written at 100k iterations (standard base64)", async () => {
    const json = await makeLegacyBackupJson("legacy-v1-payload", PASS, {
      version: 1,
      iterations: LEGACY_PBKDF2_ITERATIONS,
    });
    const env = JSON.parse(json) as CredentialEnvelope;
    expect(await openWithPassphrase(env, PASS)).toBe("legacy-v1-payload");
  });

  it("opens a version-2 backup carrying its own iteration count", async () => {
    const json = await makeLegacyBackupJson("legacy-v2-payload", PASS, {
      version: 2,
      iterations: LEGACY_PBKDF2_ITERATIONS,
    });
    const env = JSON.parse(json) as CredentialEnvelope;
    expect(await openWithPassphrase(env, PASS)).toBe("legacy-v2-payload");
  });

  it("opens a version-2 backup written at the current 600k cost", async () => {
    const json = await makeLegacyBackupJson("v2-600k", PASS, {
      version: 2,
      iterations: PBKDF2_ITERATIONS,
    });
    const env = JSON.parse(json) as CredentialEnvelope;
    expect(await openWithPassphrase(env, PASS)).toBe("v2-600k");
  });
});

describe("credential-crypto — backward compatibility with legacy transfer codes", () => {
  it("opens a compact transfer code from the pre-consolidation lib/crypto.ts", async () => {
    const code = await makeLegacyTransferCode("qr-credential", PASS, PBKDF2_ITERATIONS);
    expect(await decryptWithPassphrase(code, PASS)).toBe("qr-credential");
  });
});

describe("credential-crypto — compact transfer seal / open", () => {
  it("round-trips and stays URL-safe", async () => {
    const payload = await encryptWithPassphrase("some json", PASS);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(payload).not.toContain("some json");
    expect(await decryptWithPassphrase(payload, PASS)).toBe("some json");
  });

  it("rejects wrong passphrase and malformed codes", async () => {
    await expect(decryptWithPassphrase("not-a-real-payload", PASS)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    const payload = await encryptWithPassphrase("x", PASS);
    await expect(decryptWithPassphrase(payload.slice(0, -4), PASS)).rejects.toBeInstanceOf(
      DecryptionError,
    );
    await expect(decryptWithPassphrase(payload, "wrong-passphrase")).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });
});
