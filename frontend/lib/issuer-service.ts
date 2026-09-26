// Server-side only — never shipped to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/issuer-service.ts is server-only and must not be imported from client code.");
}

import { sha256 } from "@noble/hashes/sha2.js";
import {
  IssuerClient,
  type Credential,
  type CredentialType,
  type ClaimParams,
} from "@stellarcred/issuer";
import { env } from "./env";
import { logger, stripSensitiveFields } from "./logger";
import {
  auditLogAppend,
  auditLogBootstrap,
  auditLogFilePath,
  auditLogPersist,
} from "./audit-log";

// Server-side only — never shipped to the browser.
// Set ISSUER_PRIVATE_KEY in .env.local to the 64-char hex secp256k1 private
// key whose public key was registered in IssuerRegistry. The registered pubkey
// and the signing key must match or ProofRegistry will reject every proof.
// Falls back to a deterministic demo key so the app runs without one set.
export function getIssuerPrivateKeyHex(): string {
  return (
    env.ISSUER_PRIVATE_KEY ||
    Buffer.from(
      sha256(new TextEncoder().encode("stellarcred-demo-issuer")),
    ).toString("hex")
  );
}

if (!env.ISSUER_PRIVATE_KEY) {
  logger.warn(
    stripSensitiveFields({ event: "demo_issuer_key_active" }),
    "USING PUBLIC DEMO ISSUER KEY — not for production. Set ISSUER_PRIVATE_KEY to use a real issuer key.",
  );
}

export const issuer = new IssuerClient({ privateKey: getIssuerPrivateKeyHex() });

/**
 * The server's own public key (x || y, 64 bytes) — derived from the same key
 * `issuer` signs with, via the package's publicKey(), not re-derived locally.
 * Used to confirm the selected issuerId's on-chain registered key actually
 * matches this server's signing key before issuing.
 */
export function localIssuerPubkeyBytes(): Buffer {
  const { x, y } = issuer.publicKey();
  return Buffer.from([...x, ...y]);
}

export interface IssueAndAuditParams {
  credentialTypes: string[];
  holder: string;
  issuerId: string;
  issuerName?: string;
  expiry?: string;
  attributes: Record<string, string>;
  claimParams?: ClaimParams;
  requestId: string;
}

/**
 * Signs commitments for each requested credential type and appends
 * PII-free audit records chained to previous entries.
 */
export async function issueAndAuditCredentials(
  params: IssueAndAuditParams,
): Promise<Credential[]> {
  const {
    credentialTypes,
    holder,
    issuerId,
    issuerName = "StellarCred Authority",
    expiry = "90 days",
    attributes,
    claimParams,
    requestId,
  } = params;

  const uniqueTypes = Array.from(new Set(credentialTypes));
  const credentials: Credential[] = [];

  for (const type of uniqueTypes) {
    logger.info(
      stripSensitiveFields({
        event: "signing_started",
        credentialType: type,
        issuerId,
        walletAddress: holder,
        requestId,
      }),
    );

    const credential = await issuer.issue({
      type: type as CredentialType,
      holder,
      issuerId,
      issuerName,
      expiry,
      attribute: attributes,
      claimParams,
    });
    credentials.push(credential);

    logger.info(
      stripSensitiveFields({
        event: "signing_success",
        credentialType: type,
        issuerId,
        walletAddress: holder,
        requestId,
      }),
    );
  }

  // Hash-chained, PII-free issuance audit log
  try {
    await auditLogBootstrap(auditLogFilePath());
    for (const credential of credentials) {
      const entry = auditLogAppend({
        timestamp: credential.issuedAt,
        requestId,
        issuer: issuerId,
        commitment: credential.commitment,
      });
      logger.info(
        stripSensitiveFields({
          event: "audit_log_appended",
          credentialType: credential.type,
          issuerId,
          requestId,
          auditIndex: entry.index,
          auditHash: entry.hash,
        }),
      );
    }
    await auditLogPersist(auditLogFilePath());
  } catch (auditError) {
    logger.error(
      stripSensitiveFields({
        event: "audit_log_persist_failed",
        issuerId,
        walletAddress: holder,
        error: (auditError as Error).message,
        requestId,
      }),
    );
  }

  return credentials;
}
