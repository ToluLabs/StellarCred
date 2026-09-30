import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadCredentials,
  lockCredentialStore,
  saveCredential,
  unlockCredentialStore,
  type Credential,
} from "@/lib/credential";

describe("credential store encryption", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("stores credential data encrypted and restores it on load", async () => {
    await unlockCredentialStore("test-passphrase-123");

    const cred: Credential = {
      type: "kyc",
      title: "KYC Complete",
      claim: "identity verified",
      issuer: "Test Issuer",
      issuerId: "issuer-1",
      holder: "GTESTHOLDER",
      value: "1995-06-15",
      salt: "0xabc123",
      commitment: "0xcommitment123",
      sig: [1, 2, 3],
      issuerPubX: [4, 5, 6],
      issuerPubY: [7, 8, 9],
      issuedAt: 1700000000,
      expiry: "30 days",
    };

    await saveCredential(cred);

    const raw = localStorage.getItem("stellarcred:credentials");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("1995-06-15");
    expect(raw).not.toContain("0xabc123");
    expect(raw).not.toContain('"type":"kyc"');

    const reloaded = await loadCredentials();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      type: "kyc",
      title: "KYC Complete",
      holder: "GTESTHOLDER",
      value: "1995-06-15",
      salt: "0xabc123",
      commitment: "0xcommitment123",
    });
  });
});

// ---- #547: at-rest store migrated to the consolidated envelope scheme -------

function fixtureCredential(value: string): Credential {
  return {
    type: "kyc",
    title: "KYC Complete",
    claim: "identity verified",
    issuer: "Test Issuer",
    issuerId: "issuer-1",
    holder: "GTESTHOLDER",
    value,
    salt: "0xabc123",
    commitment: "0xcommitment123",
    sig: [1, 2, 3],
    issuerPubX: [4, 5, 6],
    issuerPubY: [7, 8, 9],
    issuedAt: 1700000000,
    expiry: "30 days",
  };
}

/** Encrypts a payload the way the pre-#547 at-rest store did (v1 envelope, 100k PBKDF2). */
async function makeLegacyAtRestEnvelope(passphrase: string, payload: unknown): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  );
  const b64 = (bytes: Uint8Array) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };
  return JSON.stringify({
    version: 1,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(ciphertext),
  });
}

describe("at-rest migration to the consolidated scheme (#547)", () => {
  beforeEach(() => {
    localStorage.clear();
    lockCredentialStore();
  });

  afterEach(() => {
    localStorage.clear();
    lockCredentialStore();
  });

  it("unlocks a legacy v1 envelope, migrates storage to the current envelope, keeps data", async () => {
    const cred = fixtureCredential("1995-06-15");
    localStorage.setItem(
      "stellarcred:credentials",
      await makeLegacyAtRestEnvelope("migrate-me", [cred]),
    );

    await unlockCredentialStore("migrate-me");

    const migrated = JSON.parse(localStorage.getItem("stellarcred:credentials") ?? "{}");
    expect(migrated.version).toBe(3);
    expect(migrated.kdf).toBe("PBKDF2-SHA256");
    expect(migrated.iterations).toBe(600_000);
    expect(await loadCredentials()).toEqual([cred]);

    // Next session: same passphrase unlocks the migrated store.
    lockCredentialStore();
    await unlockCredentialStore("migrate-me");
    expect(await loadCredentials()).toEqual([cred]);
  });

  it("writes new stores in the current envelope with no plaintext trace", async () => {
    await unlockCredentialStore("fresh-store-pw");
    await saveCredential(fixtureCredential("1995-06-15"));

    const raw = localStorage.getItem("stellarcred:credentials") ?? "";
    const env = JSON.parse(raw);
    expect(env.version).toBe(3);
    expect(env.kdf).toBe("PBKDF2-SHA256");
    expect(env.iterations).toBe(600_000);
    expect(raw).not.toContain("1995-06-15");
  });
});
