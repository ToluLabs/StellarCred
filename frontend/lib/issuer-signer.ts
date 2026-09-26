// Server-side only — never shipped to the browser.
if (typeof window !== "undefined") {
  throw new Error("lib/issuer-signer.ts is server-only and must not be imported from client code.");
}

import {
  IssuerClient,
  type Credential,
  type CredentialType,
  type ClaimParams,
} from "@stellarcred/issuer";
import { sha256 } from "@noble/hashes/sha2.js";
import { env } from "./env";
import {
  auditLogAppend,
  auditLogBootstrap,
  auditLogFilePath,
  auditLogPersist,
} from "./audit-log";
import { logger, stripSensitiveFields } from "./logger";

export interface SignParams {
  type: CredentialType;
  holder: string;
  issuerId: string;
  issuerName?: string;
  expiry?: string | number;
  attribute?: Record<string, string>;
  claimParams?: ClaimParams;
  requestId?: string;
}

export class IssuerSigner {
  private client: IssuerClient;

  constructor(privateKeyHex?: string) {
    const key =
      privateKeyHex ||
      env.ISSUER_PRIVATE_KEY ||
      Buffer.from(
        sha256(new TextEncoder().encode("stellarcred-demo-issuer")),
      ).toString("hex");

    if (!privateKeyHex && !env.ISSUER_PRIVATE_KEY) {
      logger.warn(
        stripSensitiveFields({ event: "demo_issuer_key_active" }),
        "USING PUBLIC DEMO ISSUER KEY — not for production. Set ISSUER_PRIVATE_KEY to use a real issuer key.",
      );
    }

    this.client = new IssuerClient({ privateKey: key });
  }

  publicKey(): { x: number[]; y: number[] } {
    return this.client.publicKey();
  }

  localIssuerPubkeyBytes(): Buffer {
    const { x, y } = this.client.publicKey();
    return Buffer.from([...x, ...y]);
  }

  async issueCredential(params: SignParams): Promise<Credential> {
    const {
      type,
      holder,
      issuerId,
      issuerName = "StellarCred Authority",
      expiry = "90 days",
      attribute = {},
      claimParams,
      requestId,
    } = params;

    const credential = await this.client.issue({
      type,
      holder,
      issuerId,
      issuerName,
      expiry,
      attribute,
      claimParams,
    });

    if (requestId) {
      try {
        await auditLogBootstrap(auditLogFilePath());
        const entry = auditLogAppend({
          timestamp: credential.issuedAt,
          requestId,
          issuer: issuerId,
          commitment: credential.commitment,
        });
        await auditLogPersist(auditLogFilePath());
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
      } catch (auditError) {
        logger.error(
          stripSensitiveFields({
            event: "audit_log_persist_failed",
            issuerId,
            error: (auditError as Error).message,
            requestId,
          }),
        );
      }
    }

    return credential;
  }

  async issueCredentials(
    types: CredentialType[],
    params: Omit<SignParams, "type">,
  ): Promise<Credential[]> {
    const credentials: Credential[] = [];
    for (const type of types) {
      const cred = await this.issueCredential({ ...params, type });
      credentials.push(cred);
    }
    return credentials;
  }
}

let defaultSigner: IssuerSigner | null = null;
export function getIssuerSigner(): IssuerSigner {
  if (!defaultSigner) {
    defaultSigner = new IssuerSigner();
  }
  return defaultSigner;
}
