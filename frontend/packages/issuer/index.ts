import { createHash } from "node:crypto";

/**
 * Types for the issuer package.
 */

export interface AttributeMapping {
  [key: string]: string | number | boolean;
}

export interface IssueRequest {
  /** Subject identifier (e.g. a wallet address or user id). */
  subjectId: string;
  /** Raw attributes to be mapped into the credential. */
  attributes: AttributeMapping;
  /** Optional schema identifier for the credential. */
  schemaId?: string;
  /** Optional issuer identifier. */
  issuerId?: string;
  /** When true, runs the full mapping pipeline but skips signing. */
  preview?: boolean;
  /** Optional expiration in UNIX epoch seconds. */
  expiresAt?: number;
}

export interface PublicInputs {
  /** Hex commitment to the attributes. */
  commitment: string;
  /** Hex commitment to the subject identifier. */
  subjectCommitment: string;
  /** Hex commitment to the schema identifier. */
  schemaCommitment: string;
  /** Expiration (UNIX epoch seconds), or null when none. */
  expiresAt: number | null;
}

export interface UnsignedMetadata {
  issuerId: string;
  schemaId: string;
  subjectId: string;
  attributes: AttributeMapping;
  issuedAt: number;
  expiresAt: number | null;
  version: string;
}

export interface PreviewResult {
  mode: "preview";
  commitment: string;
  publicInputs: PublicInputs;
  metadata: UnsignedMetadata;
  /** Always null in preview mode. */
  signature: null;
}

export interface SignedResult {
  mode: "issue";
  commitment: string;
  publicInputs: PublicInputs;
  metadata: UnsignedMetadata;
  signature: string;
}

export type IssueResult = PreviewResult | SignedResult;

/**
 * Signer abstraction. Provided by the caller so the issuer package never
 * imports or reads private key material directly. In preview mode this is
 * never invoked.
 */
export interface Signer {
  sign(payload: Buffer): Promise<string>;
}

export const PREVIEW_VERSION = "preview/v1";

function toHex(buf: Buffer): string {
  return buf.toString("hex");
}

/**
 * Deterministic hash of a JSON-serializable value. Keys are sorted so the
 * result is stable across runtimes and input ordering.
 */
export function deterministicHash(value: unknown): string {
  const serialized = stableStringify(value);
  return toHex(createHash("sha256").update(serialized, "utf8").digest());
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * Maps raw attributes into the canonical credential attribute set. This is
 * the single source of truth for both preview and signed issuance, so the
 * preview path never diverges from real issuance.
 */
export function mapAttributes(attributes: AttributeMapping): AttributeMapping {
  const mapped: AttributeMapping = {};
  for (const key of Object.keys(attributes).sort()) {
    const rawKey = key.trim();
    if (!rawKey) {
      continue;
    }
    const normalizedKey = rawKey.toLowerCase();
    const value = attributes[key];
    if (typeof value === "string") {
      mapped[normalizedKey] = value.trim();
    } else {
      mapped[normalizedKey] = value;
    }
  }
  return mapped;
}

/**
 * Builds the public inputs and unsigned metadata from a request. This is
 * pure and deterministic given the same input (modulo issuedAt).
 */
export function buildPayload(
  request: IssueRequest,
  options: { issuedAt?: number } = {},
): { publicInputs: PublicInputs; metadata: UnsignedMetadata } {
  if (!request.subjectId) {
    throw new Error("subjectId is required");
  }
  if (!request.attributes || typeof request.attributes !== "object") {
    throw new Error("attributes must be an object");
  }

  const mappedAttributes = mapAttributes(request.attributes);
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const expiresAt = request.expiresAt ?? null;
  const issuerId = request.issuerId ?? "default";
  const schemaId = request.schemaId ?? "default";

  const commitment = deterministicHash({
    type: "credential-commitment",
    issuerId,
    schemaId,
    subjectId: request.subjectId,
    attributes: mappedAttributes,
    issuedAt,
    expiresAt,
  });

  const subjectCommitment = deterministicHash({
    type: "subject-commitment",
    subjectId: request.subjectId,
  });

  const schemaCommitment = deterministicHash({
    type: "schema-commitment",
    schemaId,
  });

  const publicInputs: PublicInputs = {
    commitment,
    subjectCommitment,
    schemaCommitment,
    expiresAt,
  };

  const metadata: UnsignedMetadata = {
    issuerId,
    schemaId,
    subjectId: request.subjectId,
    attributes: mappedAttributes,
    issuedAt,
    expiresAt,
    version: PREVIEW_VERSION,
  };

  return { publicInputs, metadata };
}

/**
 * Runs the issuance pipeline. In preview mode the signer is never called and
 * the result contains no signature. In normal mode the caller-supplied signer
 * is invoked on the canonical payload.
 */
export async function issueCredential(
  request: IssueRequest,
  signer?: Signer,
  options: { issuedAt?: number } = {},
): Promise<IssueResult> {
  const { publicInputs, metadata } = buildPayload(request, options);

  if (request.preview) {
    return {
      mode: "preview",
      commitment: publicInputs.commitment,
      publicInputs,
      metadata,
      signature: null,
    };
  }

  if (!signer) {
    throw new Error("signer is required when preview is not enabled");
  }

  const payload = Buffer.from(stableStringify({
    commitment: publicInputs.commitment,
    subjectCommitment: publicInputs.subjectCommitment,
    schemaCommitment: publicInputs.schemaCommitment,
    expiresAt: publicInputs.expiresAt,
    metadata,
  }), "utf8");

  const signature = await signer.sign(payload);

  return {
    mode: "issue",
    commitment: publicInputs.commitment,
    publicInputs,
    metadata,
    signature,
  };
}
