import { Buffer } from "node:buffer";
import { isValidClaimType, verifyPreset, type PresetClaim } from "./claims";
import { verifyWalletClaim } from "./challenge";
import type { ChallengeStore, WalletChallenge } from "./challenge";

export interface RoutePresentation { wallet: string; challenge: WalletChallenge; signature: string }
export interface VerifiedRouteCredential { wallet: string; claims: PresetClaim[]; results: Partial<Record<PresetClaim["type"], boolean>> }
export interface RouteProtectionOptions<Request = unknown> {
  schema: readonly PresetClaim[];
  predicate: (credential: VerifiedRouteCredential, request: Request) => boolean | Promise<boolean>;
  challengeStore?: ChallengeStore;
  expectedDomain?: string;
  expectedStatement?: string;
  headerName?: string;
  maxPresentationBytes?: number;
}
export type RouteVerification =
  | { ok: true; credential: VerifiedRouteCredential }
  | { ok: false; status: 401 | 403 | 503; message: string };

export function parseRoutePresentation(value: string, maxBytes: number): RoutePresentation | null {
  if (Buffer.byteLength(value, "utf8") > maxBytes) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) return null;
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    const challenge = candidate.challenge as Record<string, unknown> | undefined;
    if (typeof candidate.wallet !== "string" || typeof candidate.signature !== "string" || !challenge ||
      typeof challenge.nonce !== "string" || typeof challenge.message !== "string" || typeof challenge.expiresAt !== "number" || typeof challenge.issuedAt !== "number" || typeof challenge.domain !== "string" || typeof challenge.statement !== "string") return null;
    return { wallet: candidate.wallet, signature: candidate.signature, challenge: challenge as unknown as WalletChallenge };
  } catch { return null; }
}

export async function verifyRoutePresentation<Request>(header: string | undefined, request: Request, options: RouteProtectionOptions<Request>): Promise<RouteVerification> {
  if (!header) return { ok: false, status: 401, message: "Missing StellarCred presentation." };
  const presentation = parseRoutePresentation(header, options.maxPresentationBytes ?? 16_384);
  if (!presentation) return { ok: false, status: 401, message: "Malformed StellarCred presentation." };
  if (presentation.challenge.expiresAt <= Date.now() || presentation.challenge.issuedAt > Date.now() || !Number.isFinite(presentation.challenge.issuedAt) || !Number.isFinite(presentation.challenge.expiresAt)) return { ok: false, status: 401, message: "StellarCred presentation has expired or is invalid." };
  const expectedMessage = [presentation.challenge.domain + " requests you sign this message to prove control of your Stellar account:", "", "Statement: " + presentation.challenge.statement, "Nonce: " + presentation.challenge.nonce, "Issued At: " + new Date(presentation.challenge.issuedAt).toISOString(), "Expires At: " + new Date(presentation.challenge.expiresAt).toISOString()].join("\n");
  if (presentation.challenge.message !== expectedMessage) return { ok: false, status: 401, message: "Presentation challenge fields do not match its signed message." };
  if (options.expectedDomain && presentation.challenge.domain !== options.expectedDomain) return { ok: false, status: 401, message: "Presentation domain does not match." };
  if (options.expectedStatement && presentation.challenge.statement !== options.expectedStatement) return { ok: false, status: 401, message: "Presentation statement does not match." };
  const firstClaim = options.schema[0];
  const proof = await verifyWalletClaim({
    wallet: presentation.wallet, challenge: presentation.challenge, signature: presentation.signature,
    claim: firstClaim.type,
    claimOptions: { minThreshold: firstClaim.minThreshold, source: "chain", fresh: true, throwOnError: true },
    store: options.challengeStore,
  });
  if (!proof.ok) {
    if (proof.failureReason === "on_chain_error") return { ok: false, status: 503, message: "Credential verification is temporarily unavailable." };
    if (!proof.signatureValid) return { ok: false, status: 401, message: "Invalid or replayed wallet challenge." };
    return { ok: false, status: 403, message: "Required credential is not valid." };
  }
  let preset;
  try {
    preset = await verifyPreset(presentation.wallet, options.schema, { source: "chain", fresh: true, throwOnError: true });
  } catch { return { ok: false, status: 503, message: "Credential verification is temporarily unavailable." }; }
  if (!preset.allValid) return { ok: false, status: 403, message: "Required credentials are not valid." };
  const credential = { wallet: presentation.wallet, claims: [...options.schema], results: preset.results };
  if (!(await options.predicate(credential, request))) return { ok: false, status: 403, message: "Credential does not satisfy this route policy." };
  return { ok: true, credential };
}

export function validateRouteProtectionOptions<Request>(options: RouteProtectionOptions<Request>): void {
  if (!Array.isArray(options.schema) || options.schema.length === 0) throw new TypeError("schema must contain at least one claim");
  if (typeof options.predicate !== "function") throw new TypeError("predicate must be a function");
  for (const claim of options.schema) {
    if (!claim || !isValidClaimType(claim.type) || (claim.minThreshold !== undefined && (!Number.isFinite(claim.minThreshold) || claim.minThreshold < 0))) throw new TypeError("schema contains an invalid claim");
  }
  if (options.maxPresentationBytes !== undefined && (!Number.isInteger(options.maxPresentationBytes) || options.maxPresentationBytes < 1)) throw new TypeError("maxPresentationBytes must be a positive integer");
  if (options.headerName !== undefined && !/^[A-Za-z0-9-]+$/.test(options.headerName)) throw new TypeError("headerName must be a valid HTTP header name");
}
