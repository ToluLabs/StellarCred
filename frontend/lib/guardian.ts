"use client";

import type { Credential } from "./credential";
import { parseCredential } from "./credential";
import { splitSecret, combineShares, type RawShare } from "./shamir";

const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export class GuardianRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardianRecoveryError";
  }
}

export interface GuardianShare {
  version: 1;
  recoveryId: string;
  guardianIndex: number;
  guardianLabel?: string;
  threshold: number;
  totalShares: number;
  createdAt: number;
  shareData: string; // Base64Url encoded share bytes
  keyFingerprint: string; // First 16 hex chars (8 bytes) of SHA-256(encryptionKey)
}

export interface GuardianEncryptedBackup {
  version: 1;
  type: "guardian-backup";
  recoveryId: string;
  createdAt: number;
  threshold: number;
  totalShares: number;
  iv: string; // Base64Url
  ciphertext: string; // Base64Url (ciphertext + 16-byte GCM auth tag)
  keyFingerprint: string; // First 16 hex chars of SHA-256(encryptionKey)
  guardianLabels?: string[];
  credentialCount: number;
}

export interface GuardianRecoveryKit {
  version: 1;
  type: "guardian-recovery-kit";
  recoveryId: string;
  createdAt: number;
  threshold: number;
  totalShares: number;
  backup: GuardianEncryptedBackup;
  shares: GuardianShare[];
}

export interface GuardianRecoverySetupOptions {
  totalShares: number;
  threshold: number;
  guardianLabels?: string[];
}

export interface GuardianRecoverySetupResult {
  backup: GuardianEncryptedBackup;
  shares: GuardianShare[];
  recoveryKit: GuardianRecoveryKit;
  rawKeyHex: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}


/** Computes the key fingerprint (first 8 bytes of SHA-256, hex encoded). */
export async function computeKeyFingerprint(keyBytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", keyBytes as BufferSource);
  const hashBytes = new Uint8Array(hash);
  return bytesToHex(hashBytes.slice(0, 8));
}

/** Generates a unique recovery identifier. */
export function generateRecoveryId(): string {
  const random = crypto.getRandomValues(new Uint8Array(6));
  return `sc_rec_${bytesToHex(random)}`;
}

/**
 * Creates a complete Guardian Recovery setup for a holder's credentials.
 *
 * 1. Generates a random 256-bit AES symmetric key.
 * 2. Encrypts the credentials with AES-256-GCM.
 * 3. Splits the symmetric key using Shamir's Secret Sharing into `totalShares` with `threshold`.
 * 4. Produces the encrypted backup file, individual guardian shares, and full recovery kit.
 */
export async function createGuardianRecoverySetup(
  credentials: Credential[],
  options: GuardianRecoverySetupOptions,
): Promise<GuardianRecoverySetupResult> {
  const { totalShares, threshold, guardianLabels } = options;

  if (threshold < 2) {
    throw new GuardianRecoveryError("Threshold must be at least 2");
  }
  if (totalShares < threshold) {
    throw new GuardianRecoveryError("Total shares must be greater than or equal to threshold");
  }
  if (totalShares > 255) {
    throw new GuardianRecoveryError("Total shares cannot exceed 255");
  }

  const recoveryId = generateRecoveryId();
  const createdAt = Math.floor(Date.now() / 1000);

  // 1. Generate 32-byte AES key
  const rawKey = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  const keyFingerprint = await computeKeyFingerprint(rawKey);

  // 2. Encrypt credentials with AES-256-GCM
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    cryptoKey,
    plaintext,
  );
  const ciphertext = new Uint8Array(ciphertextBuffer);

  const backup: GuardianEncryptedBackup = {
    version: 1,
    type: "guardian-backup",
    recoveryId,
    createdAt,
    threshold,
    totalShares,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext),
    keyFingerprint,
    guardianLabels: guardianLabels?.slice(0, totalShares),
    credentialCount: credentials.length,
  };

  // 3. Split symmetric key into Shamir shares
  const rawShares = splitSecret(rawKey, totalShares, threshold);

  const shares: GuardianShare[] = rawShares.map((rs, idx) => ({
    version: 1,
    recoveryId,
    guardianIndex: rs.index,
    guardianLabel: guardianLabels?.[idx] || undefined,
    threshold,
    totalShares,
    createdAt,
    shareData: toBase64Url(rs.data),
    keyFingerprint,
  }));

  const recoveryKit: GuardianRecoveryKit = {
    version: 1,
    type: "guardian-recovery-kit",
    recoveryId,
    createdAt,
    threshold,
    totalShares,
    backup,
    shares,
  };

  return {
    backup,
    shares,
    recoveryKit,
    rawKeyHex: bytesToHex(rawKey),
  };
}

/**
 * Reconstructs the 256-bit encryption key from a threshold of guardian shares
 * and decrypts the encrypted backup client-side.
 */
export async function recoverCredentialsFromShares(
  backup: GuardianEncryptedBackup,
  shares: GuardianShare[],
): Promise<Credential[]> {
  if (!backup || backup.version !== 1 || backup.type !== "guardian-backup") {
    throw new GuardianRecoveryError("Invalid or unsupported guardian backup file format");
  }

  if (!Array.isArray(shares) || shares.length < backup.threshold) {
    throw new GuardianRecoveryError(
      `Insufficient shares: received ${shares?.length ?? 0}, but threshold of ${backup.threshold} is required`,
    );
  }

  // Validate that all shares belong to this backup's recovery set
  const seenIndices = new Set<number>();
  const rawShares: RawShare[] = [];

  for (const s of shares) {
    if (!s || s.version !== 1) {
      throw new GuardianRecoveryError("Invalid share format");
    }
    if (s.recoveryId !== backup.recoveryId) {
      throw new GuardianRecoveryError(
        `Share for Guardian #${s.guardianIndex} belongs to recovery set "${s.recoveryId}", but the backup requires "${backup.recoveryId}"`,
      );
    }
    if (seenIndices.has(s.guardianIndex)) {
      throw new GuardianRecoveryError(
        `Duplicate share detected for Guardian #${s.guardianIndex}`,
      );
    }
    seenIndices.add(s.guardianIndex);

    let data: Uint8Array;
    try {
      data = fromBase64Url(s.shareData);
    } catch {
      throw new GuardianRecoveryError(
        `Corrupted share data for Guardian #${s.guardianIndex}`,
      );
    }

    if (data.length !== KEY_LENGTH) {
      throw new GuardianRecoveryError(
        `Invalid share data length for Guardian #${s.guardianIndex}`,
      );
    }

    rawShares.push({
      index: s.guardianIndex,
      data,
    });
  }

  // Combine threshold shares to reconstruct the 32-byte key
  let reconstructedKey: Uint8Array;
  try {
    reconstructedKey = combineShares(rawShares);
  } catch (err) {
    throw new GuardianRecoveryError(
      `Failed to combine guardian shares: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }

  // Verify key fingerprint before decryption
  const fingerprint = await computeKeyFingerprint(reconstructedKey);
  if (fingerprint !== backup.keyFingerprint) {
    throw new GuardianRecoveryError(
      "Reconstructed key verification failed. The provided shares do not match this backup or may be corrupted.",
    );
  }

  // Decrypt the ciphertext with AES-256-GCM
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = fromBase64Url(backup.iv);
    ciphertext = fromBase64Url(backup.ciphertext);
  } catch {
    throw new GuardianRecoveryError("Corrupted backup IV or ciphertext");
  }

  let plaintextBuffer: ArrayBuffer;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      reconstructedKey as BufferSource,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );

    plaintextBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      cryptoKey,
      ciphertext as BufferSource,
    );
  } catch {
    throw new GuardianRecoveryError(
      "Decryption failed: corrupted backup ciphertext or authentication tag mismatch",
    );
  }

  // Parse and validate decrypted credentials
  let parsed: unknown;
  try {
    const jsonStr = new TextDecoder().decode(plaintextBuffer);
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new GuardianRecoveryError("Decrypted payload is not valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new GuardianRecoveryError("Decrypted payload does not contain an array of credentials");
  }

  const credentials: Credential[] = [];
  for (const item of parsed) {
    try {
      credentials.push(parseCredential(JSON.stringify(item)));
    } catch (err) {
      throw new GuardianRecoveryError(
        `Corrupted credential entry in recovered backup: ${err instanceof Error ? err.message : "Invalid credential"}`,
      );
    }
  }

  return credentials;
}

/** Formats a GuardianShare as a compact armored text string for copy-pasting. */
export function formatShareArmored(share: GuardianShare): string {
  const label = share.guardianLabel ? encodeURIComponent(share.guardianLabel) : "";
  return `SC-SHARE:1:${share.recoveryId}:${share.guardianIndex}:${share.threshold}:${share.totalShares}:${share.createdAt}:${share.shareData}:${share.keyFingerprint}:${label}`;
}

/** Parses a GuardianShare from JSON or armored text representation. */
export function parseGuardianShare(input: string): GuardianShare {
  const trimmed = input.trim();

  // 1. Armored string format: SC-SHARE:1:...
  if (trimmed.startsWith("SC-SHARE:1:")) {
    const parts = trimmed.split(":");
    if (parts.length < 9) {
      throw new GuardianRecoveryError("Malformed armored share string");
    }
    const [_prefix, _versionStr, recoveryId, indexStr, threshStr, totalStr, createdStr, shareData, keyFingerprint, labelEnc] = parts;
    const guardianIndex = parseInt(indexStr, 10);
    const threshold = parseInt(threshStr, 10);
    const totalShares = parseInt(totalStr, 10);
    const createdAt = parseInt(createdStr, 10);
    const guardianLabel = labelEnc ? decodeURIComponent(labelEnc) : undefined;

    if (isNaN(guardianIndex) || isNaN(threshold) || isNaN(totalShares)) {
      throw new GuardianRecoveryError("Invalid numeric parameters in armored share");
    }

    return {
      version: 1,
      recoveryId,
      guardianIndex,
      guardianLabel,
      threshold,
      totalShares,
      createdAt,
      shareData,
      keyFingerprint,
    };
  }

  // 2. JSON format
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    throw new GuardianRecoveryError("Share input must be valid JSON or an SC-SHARE code");
  }

  if (
    !obj ||
    obj.version !== 1 ||
    typeof obj.recoveryId !== "string" ||
    typeof obj.guardianIndex !== "number" ||
    typeof obj.threshold !== "number" ||
    typeof obj.totalShares !== "number" ||
    typeof obj.shareData !== "string" ||
    typeof obj.keyFingerprint !== "string"
  ) {
    throw new GuardianRecoveryError("Invalid Guardian Share structure");
  }

  return {
    version: 1,
    recoveryId: obj.recoveryId,
    guardianIndex: obj.guardianIndex,
    guardianLabel: typeof obj.guardianLabel === "string" ? obj.guardianLabel : undefined,
    threshold: obj.threshold,
    totalShares: obj.totalShares,
    createdAt: typeof obj.createdAt === "number" ? obj.createdAt : Math.floor(Date.now() / 1000),
    shareData: obj.shareData,
    keyFingerprint: obj.keyFingerprint,
  };
}

/** Parses a GuardianEncryptedBackup or extracts it from a GuardianRecoveryKit. */
export function parseGuardianBackup(input: string): GuardianEncryptedBackup {
  let rawObj: unknown;
  try {
    rawObj = JSON.parse(input.trim());
  } catch {
    throw new GuardianRecoveryError("Backup input must be valid JSON");
  }

  let obj = (rawObj && typeof rawObj === "object") ? (rawObj as Record<string, unknown>) : null;

  // If a full recovery kit was provided, extract the backup component
  if (obj && obj.type === "guardian-recovery-kit" && obj.backup && typeof obj.backup === "object") {
    obj = obj.backup as Record<string, unknown>;
  }

  if (
    !obj ||
    obj.version !== 1 ||
    obj.type !== "guardian-backup" ||
    typeof obj.recoveryId !== "string" ||
    typeof obj.threshold !== "number" ||
    typeof obj.totalShares !== "number" ||
    typeof obj.iv !== "string" ||
    typeof obj.ciphertext !== "string" ||
    typeof obj.keyFingerprint !== "string"
  ) {
    throw new GuardianRecoveryError("Invalid Guardian Encrypted Backup file structure");
  }

  return {
    version: 1,
    type: "guardian-backup",
    recoveryId: obj.recoveryId,
    createdAt: typeof obj.createdAt === "number" ? obj.createdAt : Math.floor(Date.now() / 1000),
    threshold: obj.threshold,
    totalShares: obj.totalShares,
    iv: obj.iv,
    ciphertext: obj.ciphertext,
    keyFingerprint: obj.keyFingerprint,
    guardianLabels: Array.isArray(obj.guardianLabels) ? (obj.guardianLabels as string[]) : undefined,
    credentialCount: typeof obj.credentialCount === "number" ? obj.credentialCount : 0,
  };
}

/** Parses a complete GuardianRecoveryKit. */
export function parseRecoveryKit(input: string): GuardianRecoveryKit {
  let rawObj: unknown;
  try {
    rawObj = JSON.parse(input.trim());
  } catch {
    throw new GuardianRecoveryError("Recovery kit input must be valid JSON");
  }

  const obj = (rawObj && typeof rawObj === "object") ? (rawObj as Record<string, unknown>) : null;

  if (
    !obj ||
    obj.version !== 1 ||
    obj.type !== "guardian-recovery-kit" ||
    !obj.backup ||
    !Array.isArray(obj.shares)
  ) {
    throw new GuardianRecoveryError("Invalid Guardian Recovery Kit file structure");
  }

  return (obj as unknown) as GuardianRecoveryKit;
}

/** Downloads a GuardianEncryptedBackup file as JSON. */
export function downloadGuardianBackup(
  backup: GuardianEncryptedBackup,
  filename?: string,
): void {
  const name =
    filename ||
    `stellarcred-guardian-backup-${backup.recoveryId}-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

/** Downloads an individual GuardianShare file as JSON. */
export function downloadGuardianShare(
  share: GuardianShare,
  filename?: string,
): void {
  const safeLabel = share.guardianLabel
    ? `-${share.guardianLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    : "";
  const name =
    filename ||
    `stellarcred-guardian-share-${share.guardianIndex}-of-${share.totalShares}${safeLabel}.json`;
  const blob = new Blob([JSON.stringify(share, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

/** Downloads a full GuardianRecoveryKit file as JSON. */
export function downloadRecoveryKit(
  kit: GuardianRecoveryKit,
  filename?: string,
): void {
  const name =
    filename ||
    `stellarcred-recovery-kit-${kit.recoveryId}-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(kit, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
