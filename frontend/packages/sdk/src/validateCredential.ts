// @stellarcred/sdk — credential JSON validation (#27)
//
// Verifiers, importers, and QR-scan flows accept credential JSON from an
// untrusted source. This helper checks the shape and required metadata before
// that data reaches storage or a verification flow, and returns every problem
// at once so integrators can tell the user exactly which field is wrong.
//
// The validator is pure and dependency-free: it never signs, decrypts, or
// contacts the network, and it does not check whether a commitment is valid
// on-chain. Use `hasClaim` / `checkClaimStatus` for the authoritative check;
// use this helper to reject malformed input early.

import { CLAIM_TYPES } from "./claims";

/**
 * Credential types the issuance service can mint. Mirrors the issuer's
 * `CREDENTIAL_TYPES`; `employment` is supported on-chain but is not part of
 * `CLAIM_TYPES`, which only lists claim checks the SDK reads.
 */
export const CREDENTIAL_TYPES = [...CLAIM_TYPES, "employment"] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/** Proof parameters carried by parameterised credentials. */
export interface CredentialClaimParams {
  threshold_years?: string;
  threshold?: string;
  restricted?: string[];
  /** "0" = denylist/block (default), "1" = allowlist/allow. */
  mode?: string;
}

/**
 * Canonical credential shape returned by `/api/issue`.
 *
 * `value` and `salt` are secrets: validators must not log or persist the whole
 * object when it is untrusted input.
 */
export interface CredentialJson {
  type: CredentialType;
  title: string;
  claim: string;
  issuer: string;
  issuerId: string;
  holder: string;
  value: string;
  salt: string;
  commitment: string;
  sig: number[];
  issuerPubX: number[];
  issuerPubY: number[];
  issuedAt: number;
  expiry: string;
  /** Issuer-attested tenure (years), present on employment credentials. */
  seniority?: string;
  claimParams?: CredentialClaimParams;
}

/** One rejected field, with a message safe to show to the caller. */
export interface CredentialValidationIssue {
  /** Dotted path to the offending field (`""` for the root value). */
  path: string;
  message: string;
}

export type CredentialValidationResult =
  | { valid: true; credential: CredentialJson }
  | { valid: false; errors: CredentialValidationIssue[] };

/** Thrown by {@link assertValidCredential}. Carries every issue found. */
export class CredentialValidationError extends Error {
  readonly issues: CredentialValidationIssue[];

  constructor(issues: CredentialValidationIssue[]) {
    super(
      `Invalid credential JSON: ${issues
        .map((issue) => `${issue.path || "credential"} — ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "CredentialValidationError";
    this.issues = issues;
  }
}

const HEX_FIELD = /^(0x)?[0-9a-f]+$/i;
const REQUIRED_STRINGS = [
  "title",
  "claim",
  "issuer",
  "issuerId",
  "holder",
  "value",
  "salt",
  "commitment",
  "expiry",
] as const;

/**
 * Validates a credential object (already parsed from JSON).
 *
 * Returns `{ valid: true, credential }` when every required field is present
 * and well-typed, or `{ valid: false, errors }` with an issue per problem.
 * Extra fields are preserved on the returned credential.
 *
 * @example
 * ```ts
 * const result = validateCredential(JSON.parse(pasted));
 * if (!result.valid) {
 *   for (const issue of result.errors) console.error(issue.path, issue.message);
 * }
 * ```
 */
export function validateCredential(input: unknown): CredentialValidationResult {
  if (!isRecord(input)) {
    return {
      valid: false,
      errors: [
        {
          path: "",
          message: "Credential must be a JSON object.",
        },
      ],
    };
  }

  const errors: CredentialValidationIssue[] = [];

  if (typeof input.type !== "string") {
    errors.push({ path: "type", message: "must be a string." });
  } else if (!(CREDENTIAL_TYPES as readonly string[]).includes(input.type)) {
    errors.push({
      path: "type",
      message: `must be one of ${CREDENTIAL_TYPES.join(", ")}. Received "${input.type}".`,
    });
  }

  for (const field of REQUIRED_STRINGS) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      errors.push({ path: field, message: "must be a non-empty string." });
    }
  }

  for (const field of ["value", "salt", "commitment"] as const) {
    if (
      typeof input[field] === "string" &&
      input[field].length > 0 &&
      !HEX_FIELD.test(input[field])
    ) {
      errors.push({
        path: field,
        message: "must be a numeric or 0x-prefixed field string.",
      });
    }
  }

  if (typeof input.expiry === "string" && !/\d/.test(input.expiry) && input.expiry.length > 0) {
    errors.push({
      path: "expiry",
      message: 'must be a parseable duration containing a number (e.g. "90 days").',
    });
  }

  validateByteArray(input.sig, "sig", 64, errors);
  validateByteArray(input.issuerPubX, "issuerPubX", 32, errors);
  validateByteArray(input.issuerPubY, "issuerPubY", 32, errors);

  if (!Number.isInteger(input.issuedAt) || (input.issuedAt as number) < 0) {
    errors.push({
      path: "issuedAt",
      message: "must be a non-negative integer Unix timestamp (seconds).",
    });
  }

  if (input.seniority !== undefined) {
    if (typeof input.seniority !== "string" || !/^\d+$/.test(input.seniority)) {
      errors.push({
        path: "seniority",
        message: "must be a non-negative integer string when present.",
      });
    }
  }

  if (input.claimParams !== undefined) {
    validateClaimParams(input.claimParams, errors);
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, credential: input as unknown as CredentialJson };
}

/**
 * Parses credential JSON text and validates the result. Returns a validation
 * failure (never throws) for malformed JSON, so callers can render the same
 * error list for both parse and shape problems.
 */
export function parseCredentialJson(json: string): CredentialValidationResult {
  if (typeof json !== "string") {
    return {
      valid: false,
      errors: [{ path: "", message: "Credential JSON must be a string." }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      valid: false,
      errors: [{ path: "", message: "Invalid JSON." }],
    };
  }

  return validateCredential(parsed);
}

/**
 * Throws {@link CredentialValidationError} when `input` is not a valid
 * credential. Useful in server handlers that want to fail fast.
 *
 * @example
 * ```ts
 * try {
 *   assertValidCredential(body.credential);
 * } catch (err) {
 *   if (err instanceof CredentialValidationError) return badRequest(err.issues);
 *   throw err;
 * }
 * ```
 */
export function assertValidCredential(input: unknown): asserts input is CredentialJson {
  const result = validateCredential(input);
  if (!result.valid) throw new CredentialValidationError(result.errors);
}

function validateByteArray(
  value: unknown,
  path: string,
  length: number,
  errors: CredentialValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    errors.push({
      path,
      message: `must be an array of ${length} bytes.`,
    });
    return;
  }
  if (value.length !== length) {
    errors.push({
      path,
      message: `must contain exactly ${length} bytes (received ${value.length}).`,
    });
    return;
  }
  if (!value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    errors.push({
      path,
      message: "must contain only integers in [0, 255].",
    });
  }
}

function validateClaimParams(value: unknown, errors: CredentialValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path: "claimParams", message: "must be an object." });
    return;
  }

  for (const field of ["threshold_years", "threshold", "mode"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      errors.push({
        path: `claimParams.${field}`,
        message: "must be a string when present.",
      });
    }
  }

  if (value.restricted !== undefined) {
    if (!Array.isArray(value.restricted)) {
      errors.push({
        path: "claimParams.restricted",
        message: "must be an array of strings when present.",
      });
    } else if (!value.restricted.every((entry) => typeof entry === "string")) {
      errors.push({
        path: "claimParams.restricted",
        message: "must contain only strings.",
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
