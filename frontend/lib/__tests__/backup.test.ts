import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentRef } from "../deployment";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

const CURRENT_CONTRACTS = {
  issuerRegistry: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMOCKR",
  credentialVerifier: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMOCKV",
  proofRegistry: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMOCKP",
  gatedPool: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMOCKG",
};

vi.mock("../stellar", () => ({
  NETWORK: "testnet",
  NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
  CONTRACTS: { ...CURRENT_CONTRACTS },
  CREDENTIAL_TYPES: [
    "kyc",
    "age",
    "jurisdiction",
    "income",
    "funds",
    "accreditation",
    "employment",
  ],
}));

const { createEncryptedBackup, decryptBackup, mergeCredentials } = await import("../backup");
const { CREDENTIALS_STORAGE_KEY } = await import("../credential");

const PASSPHRASE = "correct horse battery staple";
function deploymentRef(networkPassphrase: string): DeploymentRef {
  return {
    network: networkPassphrase === TESTNET_PASSPHRASE ? "testnet" : "mainnet",
    networkPassphrase,
    contracts: { ...CURRENT_CONTRACTS },
  };
}

function storedCredential(deployment?: unknown) {
  return {
    type: "kyc",
    title: "KYC Complete",
    claim: "identity verified",
    issuer: "Test Issuer",
    issuerId: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXY234",
    holder: "GTESTHOLDER",
    value: "0x1234",
    salt: "0xabcd",
    commitment: "0xdeadbeef",
    sig: Array(64).fill(7),
    issuerPubX: Array(32).fill(1),
    issuerPubY: Array(32).fill(2),
    issuedAt: 1700000000,
    expiry: "30 days",
    ...(deployment ? { deployment } : {}),
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("createEncryptedBackup", () => {
  it("emits a version-3 consolidated envelope and records the current deployment", async () => {
    localStorage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify([storedCredential()]));
    const backup = await createEncryptedBackup(PASSPHRASE);
    expect(backup.version).toBe(3);
    expect(backup.kdf).toBe("PBKDF2-SHA256");
    expect(backup.iterations).toBe(600_000);
    expect(backup.deployment).toEqual(deploymentRef(TESTNET_PASSPHRASE));
  });
});

// ---- backward compatibility with pre-#547 backup files -----------------------

function toLegacyBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Encrypts like the old backup.ts did, at the given KDF cost, in standard base64. */
async function makeLegacyEnvelope(
  payload: unknown,
  passphrase: string,
  version: 1 | 2,
  iterations: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
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
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
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
  const env: Record<string, unknown> = {
    version,
    salt: toLegacyBase64(salt),
    iv: toLegacyBase64(iv),
    ciphertext: toLegacyBase64(ciphertext),
  };
  if (version === 2) env.iterations = iterations;
  return env;
}

describe("decryptBackup legacy envelopes (#547 backward compatibility)", () => {
  it("decrypts a v1 backup (100k iterations, no iterations field)", async () => {
    const cred = storedCredential();
    const legacy = await makeLegacyEnvelope([cred], PASSPHRASE, 1, 100_000);

    const restored = await decryptBackup(legacy, PASSPHRASE);
    expect(restored).toHaveLength(1);
    expect(restored[0].commitment).toBe(cred.commitment);
  });

  it("decrypts a v2 backup (explicit iteration count)", async () => {
    const cred = storedCredential();
    const legacy = await makeLegacyEnvelope([cred], PASSPHRASE, 2, 600_000);

    const restored = await decryptBackup(legacy, PASSPHRASE);
    expect(restored[0].commitment).toBe(cred.commitment);
  });

  it("still rejects a wrong passphrase on legacy envelopes", async () => {
    const legacy = await makeLegacyEnvelope([storedCredential()], PASSPHRASE, 1, 100_000);
    await expect(decryptBackup(legacy, "not-the-passphrase")).rejects.toThrow(
      "Wrong passphrase or corrupted backup",
    );
  });

  it("rejects an unknown future version", async () => {
    const legacy = await makeLegacyEnvelope([storedCredential()], PASSPHRASE, 2, 100_000);
    legacy.version = 9;
    await expect(decryptBackup(legacy, PASSPHRASE)).rejects.toThrow(
      "Unsupported backup version",
    );
  });
});

describe("decryptBackup cross-deployment guard (#545)", () => {
  it("rejects a backup whose envelope deployment is on another network", async () => {
    localStorage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify([storedCredential()]));
    const backup = await createEncryptedBackup(PASSPHRASE);
    backup.deployment = deploymentRef(MAINNET_PASSPHRASE);

    await expect(decryptBackup(backup, PASSPHRASE)).rejects.toThrow(
      /belongs to another deployment/,
    );
  });

  it("rejects a backup whose credentials carry a foreign deployment even without the envelope field", async () => {
    localStorage.setItem(
      CREDENTIALS_STORAGE_KEY,
      JSON.stringify([storedCredential(deploymentRef(MAINNET_PASSPHRASE))]),
    );
    const backup = await createEncryptedBackup(PASSPHRASE);
    // Simulate an envelope written by an older exporter that predates the
    // plaintext deployment field — the per-credential check must still fire.
    delete (backup as { deployment?: unknown }).deployment;

    await expect(decryptBackup(backup, PASSPHRASE)).rejects.toThrow(
      /belongs to another deployment/,
    );
  });

  it("round-trips a backup from this deployment", async () => {
    const cred = storedCredential(deploymentRef(TESTNET_PASSPHRASE));
    localStorage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify([cred]));
    const backup = await createEncryptedBackup(PASSPHRASE);

    const restored = await decryptBackup(backup, PASSPHRASE);
    expect(restored).toHaveLength(1);
    expect(restored[0].commitment).toBe(cred.commitment);
  });
});

describe("mergeCredentials cross-deployment guard (#545)", () => {
  it("refuses to merge a foreign-deployment credential", async () => {
    localStorage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify([]));
    await expect(
      mergeCredentials([storedCredential(deploymentRef(MAINNET_PASSPHRASE)) as never]),
    ).rejects.toThrow(/belongs to another deployment/);
  });
});
