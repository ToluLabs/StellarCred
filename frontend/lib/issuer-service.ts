// Server-side only — never shipped to the browser.
if (typeof window !== "undefined") {
  throw new Error(
    "lib/issuer-service.ts is server-only and must not be imported from client code.",
  );
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
import { auditLogAppend, auditLogBootstrap, auditLogFilePath, auditLogPersist } from "./audit-log";
import { enqueueOutboundEvent } from "./outbound-sink";

import { resolveSigningKey } from "./secrets-vault";

// Server-side only — never shipped to the browser.
// Set ISSUER_PRIVATE_KEY in .env.local to the 64-char hex secp256k1 private
// key whose public key was registered in IssuerRegistry. The registered pubkey
// and the signing key must match or ProofRegistry will reject every proof.
// Falls back to a deterministic demo key so the app runs without one set.
export function getIssuerPrivateKeyHex(): string {
  return (
    env.ISSUER_PRIVATE_KEY ||
    Buffer.from(sha256(new TextEncoder().encode("stellarcred-demo-issuer"))).toString("hex")
  );
}

/**
 * Dynamically resolves an issuer signing key from the active secrets provider
 * (e.g. Vault or Env), falling back to getIssuerPrivateKeyHex().
 */
export async function resolveIssuerSigningKey(secretRef?: string): Promise<string> {
  const resolved = await resolveSigningKey(secretRef);
  return resolved || getIssuerPrivateKeyHex();
}

if (!env.ISSUER_PRIVATE_KEY) {
  logger.warn(
    stripSensitiveFields({ event: "demo_issuer_key_active" }),
    "USING PUBLIC DEMO ISSUER KEY — not for production. Set ISSUER_PRIVATE_KEY to use a real issuer key.",
  );
}

export const issuer = new IssuerClient({ privateKey: getIssuerPrivateKeyHex() });

/**
 * Creates an IssuerClient instance configured with the specified private key.
 */
export function createIssuerClient(privateKeyHex: string): IssuerClient {
  return new IssuerClient({ privateKey: privateKeyHex });
}

/**
 * The server's own public key (x || y, 64 bytes) — derived from the same key
 * `issuer` signs with, via the package's publicKey(), not re-derived locally.
 * If a custom client is provided, uses its public key instead.
 */
export function localIssuerPubkeyBytes(customClient?: IssuerClient): Buffer {
  const { x, y } = (customClient || issuer).publicKey();
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
  issuerClient?: IssuerClient;
  signingKeyHex?: string;
  /**
   * When true, credentials are generated (commitment, attribute mapping,
   * payload structure) without performing a real signature, without touching
   * signing keys, and without writing to the audit log or outbound sink.
   */
  preview?: boolean;
}

/**
 * Result of a preview issuance: unsigned metadata only, no signature material.
 */
export interface PreviewCredential {
  type: string;
  holder: string;
  issuerId: string;
  issuerName: string;
  expiry: string;
  attributes: Record<string, string>;
  claimParams?: ClaimParams;
  preview: true;
  signed: false;
}

/**
 * Builds deterministic unsigned credential metadata for sandbox/test flows.
 * Never reads ISSUER_PRIVATE_KEY, never invokes the issuer client's signing
 * path, and never calls external providers or the audit/outbound sinks.
 */
export function previewCredentials(params: IssueAndAuditParams): PreviewCredential[] {
  const {
    credentialTypes,
    holder,
    issuerId,
    issuerName = "StellarCred Authority",
    expiry = "90 days",
    attributes,
    claimParams,
  } = params;

  const uniqueTypes = Array.from(new Set(credentialTypes));
  return uniqueTypes.map((type) => ({
    type,
    holder,
    issuerId,
    issuerName,
    expiry,
    attributes,
    claimParams,
    preview: true as const,
    signed: false as const,
  }));
}

/**
 * Signs commitments for each requested credential type and appends
 * PII-free audit records chained to previous entries.
 *
 * When `preview` is true, delegates to previewCredentials() and returns
 * unsigned metadata without any signing, key access, or audit writes.
 */
export async function issueAndAuditCredentials(
  params: IssueAndAuditParams,
): Promise<Credential[] | PreviewCredential[]> {
  if (params.preview) {
    logger.info(
      stripSensitiveFields({
        event: "preview_issuance",
        issuerId: params.issuerId,
        walletAddress: params.holder,
        requestId: params.requestId,
      }),
    );
    return previewCredentials(params);
  }

  const {
    credentialTypes,
    holder,
    issuerId,
    issuerName = "StellarCred Authority",
    expiry = "90 days",
    attributes,
    claimParams,
    requestId,
    issuerClient,
    signingKeyHex,
  } = params;

  const client = issuerClient || (signingKeyHex ? createIssuerClient(signingKeyHex) : issuer);

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

    const credential = await client.issue({
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
      // Audit persistence remains synchronous so the hash chain is durable
      // before issuance returns; the shared sink publishes the same redacted
      // entry without adding network latency to the request.
      enqueueOutboundEvent({ kind: "audit", payload: entry });
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
