// Circuit-shape validation for the witness builder.
//
// `/api/witness` used to cast request fields straight into the Noir `InputMap`
// (`cred.sig as number[]`, `String(cred.value)`, …). A wrong-length signature or
// a non-numeric byte then surfaced as an opaque failure from inside Noir, or —
// worse — built a witness from nonsense. These checks run first so a malformed
// request gets a precise 400 naming the offending field.
//
// Error messages describe the *shape* that was wrong and never echo the value:
// `value`, `salt` and `commitment` are credential secrets.

/** The jurisdiction circuit takes a fixed-size restricted-country list. */
export const RESTRICTED_LEN = 8;

/** BN254 scalar field modulus — every Noir `Field` input must be below this. */
const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const SIG_LEN = 64;
const PUBKEY_COORD_LEN = 32;

/** Decimal (`"1234"`) or hex (`"0x1a2b"`) — both are accepted by Noir. */
const FIELD_STRING_RE = /^(0x[0-9a-fA-F]+|[0-9]+)$/;

const DIGITS_RE = /^[0-9]+$/;

export interface ClaimParams {
  threshold_years?: string;
  threshold?: string;
  min?: string;
  max?: string;
  restricted?: string[];
  /** "0" = denylist (default), "1" = allowlist */
  mode?: string;
}

/** A single failed check: which request field, and what was wrong with it. */
export interface WitnessValidationError {
  field: string;
  message: string;
}

/**
 * The circuit expects exactly {@link RESTRICTED_LEN} entries; pad with "0".
 * Only ever called with a list already validated to be within that length, so
 * this pads and never truncates.
 */
export function normalizeRestricted(list: string[]): string[] {
  const padded = list.slice(0, RESTRICTED_LEN);
  while (padded.length < RESTRICTED_LEN) padded.push("0");
  return padded;
}

const err = (field: string, message: string): WitnessValidationError => ({ field, message });

/** A byte array of exactly `len` entries, every entry an integer in [0,255]. */
function checkByteArray(
  value: unknown,
  field: string,
  len: number,
): WitnessValidationError | null {
  if (!Array.isArray(value)) return err(field, `must be an array of ${len} bytes`);
  if (value.length !== len) {
    return err(field, `must be exactly ${len} bytes, received ${value.length}`);
  }
  for (let i = 0; i < value.length; i++) {
    const b = value[i];
    if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255) {
      return err(`${field}[${i}]`, "must be an integer between 0 and 255");
    }
  }
  return null;
}

/**
 * A field element: a decimal or hex string (numbers are accepted and coerced by
 * the caller), non-empty and below the BN254 modulus.
 */
function checkField(value: unknown, field: string): WitnessValidationError | null {
  if (value === undefined || value === null) return err(field, "is required");

  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      return err(field, "must be a non-negative integer");
    }
    return null;
  }

  if (typeof value !== "string") return err(field, "must be a numeric string");
  if (!FIELD_STRING_RE.test(value)) {
    return err(field, "must be a decimal or 0x-prefixed hex numeric string");
  }
  if (BigInt(value) >= FIELD_MODULUS) return err(field, "exceeds the BN254 field modulus");
  return null;
}

/** A threshold: an integer, given as a decimal string or a number. */
function checkThreshold(value: unknown, field: string): WitnessValidationError | null {
  if (value === undefined) return null; // optional — the route applies a default

  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      return err(field, "must be a non-negative integer");
    }
    return null;
  }

  if (typeof value !== "string" || !DIGITS_RE.test(value)) {
    return err(field, "must be a non-negative integer");
  }
  if (BigInt(value) >= FIELD_MODULUS) return err(field, "exceeds the BN254 field modulus");
  return null;
}

/**
 * The PoC aggregate circuit asserts `num_credentials == 2`, so a wrong count
 * must be rejected here with a precise message rather than surfacing as an
 * opaque Noir assertion failure. Accepts "2" or the number 2.
 */
function checkAggregateCount(value: unknown): WitnessValidationError | null {
  const asString = typeof value === "number" ? String(value) : value;
  if (asString !== "2") {
    return err("credential.num_credentials", "must be \"2\" for the N=2 aggregate circuit");
  }
  return null;
}

/** The restricted-country list: at most RESTRICTED_LEN numeric ISO 3166-1 codes. */
function checkRestricted(value: unknown): WitnessValidationError | null {
  const field = "credential.claimParams.restricted";
  if (value === undefined) return null; // optional — the route applies a default

  if (!Array.isArray(value)) return err(field, "must be an array of numeric ISO 3166-1 codes");
  // Truncating here would silently drop restrictions the caller asked to
  // enforce, so an over-long list is rejected rather than normalized.
  if (value.length > RESTRICTED_LEN) {
    return err(field, `accepts at most ${RESTRICTED_LEN} entries, received ${value.length}`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value[i];
    const asString =
      typeof code === "number" && Number.isInteger(code) && code >= 0 ? String(code) : code;
    if (typeof asString !== "string" || !DIGITS_RE.test(asString) || Number(asString) > 999) {
      return err(`${field}[${i}]`, "must be a numeric ISO 3166-1 country code (0-999)");
    }
  }
  return null;
}

/**
 * Validates one credential against the shape its circuit expects.
 *
 * Returns the first failed check, or `null` when the credential is safe to hand
 * to the witness builder. Unknown types are validated as `kyc`, matching the
 * builder's own fallback.
 */
export function validateWitnessCredential(
  type: string,
  cred: Record<string, unknown>,
): WitnessValidationError | null {
  // The aggregate payload uses prefixed keys that mirror the circuit's
  // parameter names (see computeAggregateWitness in lib/proof.ts) instead of
  // the single-proof value/salt/commitment shape, so it is validated against
  // its own full set of 15 inputs: 6 private fields (secrets, salts,
  // signatures) + 9 public fields (commitments, issuer pubkeys, age
  // date/threshold, num_credentials).
  if (type === "aggregate") {
    return (
      checkField(cred.kyc_secret, "credential.kyc_secret") ??
      checkField(cred.kyc_salt, "credential.kyc_salt") ??
      checkByteArray(cred.kyc_sig, "credential.kyc_sig", SIG_LEN) ??
      checkField(cred.kyc_commitment, "credential.kyc_commitment") ??
      checkByteArray(cred.kyc_issuer_x, "credential.kyc_issuer_x", PUBKEY_COORD_LEN) ??
      checkByteArray(cred.kyc_issuer_y, "credential.kyc_issuer_y", PUBKEY_COORD_LEN) ??
      checkField(cred.age_date_of_birth, "credential.age_date_of_birth") ??
      checkField(cred.age_salt, "credential.age_salt") ??
      checkByteArray(cred.age_sig, "credential.age_sig", SIG_LEN) ??
      checkField(cred.age_commitment, "credential.age_commitment") ??
      checkByteArray(cred.age_issuer_x, "credential.age_issuer_x", PUBKEY_COORD_LEN) ??
      checkByteArray(cred.age_issuer_y, "credential.age_issuer_y", PUBKEY_COORD_LEN) ??
      // age_current_date is deliberately NOT required here: the route derives
      // it server-side (like the single-proof age path), so a client-supplied
      // value would only ever be discarded.
      checkField(cred.age_threshold_years, "credential.age_threshold_years") ??
      checkField(cred.num_credentials, "credential.num_credentials") ??
      checkAggregateCount(cred.num_credentials)
    );
  }

  // Common to every circuit: the committed value, its salt, the commitment, and
  // the issuer signature over that commitment.
  const common =
    checkField(cred.value, "credential.value") ??
    checkField(cred.salt, "credential.salt") ??
    checkField(cred.commitment, "credential.commitment") ??
    checkByteArray(cred.sig, "credential.sig", SIG_LEN) ??
    checkByteArray(cred.issuerPubX, "credential.issuerPubX", PUBKEY_COORD_LEN) ??
    checkByteArray(cred.issuerPubY, "credential.issuerPubY", PUBKEY_COORD_LEN);
  if (common) return common;

  const rawParams = cred.claimParams;
  if (rawParams !== undefined && (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams))) {
    return err("credential.claimParams", "must be an object");
  }
  const params = (rawParams ?? {}) as ClaimParams;

  switch (type) {
    case "age":
      return checkThreshold(params.threshold_years, "credential.claimParams.threshold_years");
    case "income": {
      const thresholdErr = checkThreshold(params.threshold, "credential.claimParams.threshold");
      if (thresholdErr) return thresholdErr;

      const minErr = checkThreshold(params.min, "credential.claimParams.min");
      if (minErr) return minErr;

      const maxErr = checkThreshold(params.max, "credential.claimParams.max");
      if (maxErr) return maxErr;

      if ((params.min !== undefined) !== (params.max !== undefined)) {
        return err(
          "credential.claimParams",
          "must provide both min and max for income range mode",
        );
      }
      if (params.min !== undefined && params.max !== undefined) {
        const min = BigInt(params.min);
        const max = BigInt(params.max);
        if (min > max) {
          return err("credential.claimParams.max", "must be greater than or equal to credential.claimParams.min");
        }
      }
      return null;
    }
    case "funds":
    case "accreditation":
      return checkThreshold(params.threshold, "credential.claimParams.threshold");
    case "jurisdiction":
      return checkRestricted(params.restricted);
    default:
      return null;
  }
}
