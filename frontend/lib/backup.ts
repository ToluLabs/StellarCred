"use client";

import type { Credential } from "./credential";
import { loadCredentials, saveCredential } from "./credential";
import {
  currentDeploymentRef,
  deploymentMismatchMessage,
  type DeploymentRef,
} from "./deployment";
import {
  DecryptionError,
  openWithPassphrase,
  sealWithPassphrase,
  type CredentialEnvelope,
  type CredentialKdf,
  type SealedPassphraseEnvelope,
} from "./credential-crypto";

/**
 * Credential backup file. New exports are version 3 envelopes of the
 * consolidated scheme (lib/credential-crypto.ts); imports still accept
 * version 1 (legacy, 100k PBKDF2 iterations) and version 2 backups.
 */
export interface EncryptedBackup extends SealedPassphraseEnvelope {
  /**
   * Deployment that created the backup (Issue #545). Recorded at export so
   * restoring onto a different network / contract set is caught here, at
   * import time, instead of failing confusingly at proof submission.
   */
  deployment?: DeploymentRef;
}

/** Backup envelopes written by older app versions — still importable. */
type LegacyBackupEnvelope = CredentialEnvelope & {
  version: 1 | 2;
  kdf?: CredentialKdf;
  deployment?: DeploymentRef;
};

export type BackupEnvelope = EncryptedBackup | LegacyBackupEnvelope;

export async function createEncryptedBackup(
  passphrase: string
): Promise<EncryptedBackup> {
  if (!passphrase) {
    throw new Error("Passphrase must not be empty");
  }
  const credentials = await loadCredentials();
  const sealed = await sealWithPassphrase(JSON.stringify(credentials), passphrase);

  return {
    ...sealed,
    deployment: currentDeploymentRef(),
  };
}

export async function decryptBackup(
  backup: BackupEnvelope,
  passphrase: string
): Promise<Credential[]> {
  if (backup.version !== 1 && backup.version !== 2 && backup.version !== 3) {
    throw new Error("Unsupported backup version");
  }

  // Cross-deployment guard (#545). The envelope's deployment is stored in
  // plaintext, so a backup from another network / contract set is rejected
  // before the expensive PBKDF2 derivation, and per-credential references
  // are checked after decryption in case the envelope field is absent.
  const envelopeMismatch = deploymentMismatchMessage(
    "deployment" in backup ? backup.deployment : undefined,
  );
  if (envelopeMismatch) throw new Error(envelopeMismatch);

  let plaintext: string;
  try {
    plaintext = await openWithPassphrase(backup, passphrase);
  } catch (err) {
    if (err instanceof DecryptionError) {
      throw new Error("Wrong passphrase or corrupted backup");
    }
    throw err;
  }

  const parsed = JSON.parse(plaintext);

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid backup contents");
  }

  // Validate each entry has required Credential fields
  for (const item of parsed) {
    if (
      !item ||
      typeof item !== "object" ||
      !item.type ||
      item.value === undefined ||
      !item.commitment ||
      !item.issuerId ||
      !item.sig
    ) {
      throw new Error("Invalid backup contents: malformed credential entry");
    }
    // Credentials restored via v1/legacy envelopes carry no envelope
    // deployment, so enforce the same-origin rule per credential too (#545).
    const mismatch = deploymentMismatchMessage(item.deployment);
    if (mismatch) throw new Error(mismatch);
  }

  return parsed as Credential[];
}

export async function mergeCredentials(imported: Credential[]): Promise<Credential[]> {
  let current = await loadCredentials();

  for (const cred of imported) {
    // Defense in depth: callers other than decryptBackup must not be able to
    // merge a foreign-deployment credential past the import-time guard (#545).
    const mismatch = deploymentMismatchMessage(cred.deployment);
    if (mismatch) throw new Error(mismatch);
    current = await saveCredential(cred);
  }

  return current;
}

export function downloadBackup(
  backup: EncryptedBackup,
  filename = "stellarcred-backup.json"
) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 100);
}
