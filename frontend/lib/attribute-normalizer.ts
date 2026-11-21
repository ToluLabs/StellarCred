/**
 * lib/attribute-normalizer.ts
 *
 * Single source of truth for mapping the request-level `attribute` shorthand
 * (a single string, one per credential type) onto the type-specific field in
 * `attributes` that the issuer circuit commits to. The field names mirror
 * `attributeToValue` in @stellarcred/issuer (packages/issuer/src/index.ts).
 *
 * This logic used to be duplicated inline in POST /api/issue,
 * POST /api/issue/batch, and the issuer page — adding a credential type
 * meant editing every copy. Adding one now means a single entry in
 * ATTRIBUTE_FIELD_BY_TYPE below (the Record<CredentialType, …> type makes
 * the compiler flag the omission).
 */

import type { CredentialType } from "@/lib/stellar";

/**
 * The `attributes` field each credential type commits to, or `undefined` for
 * types with no user-supplied attribute (kyc — a binary claim; employment's
 * status is always "1", with seniority read separately from
 * attribute.seniority as a second preimage value).
 *
 * Note: the `funds` entry is only a convenience default for the shorthand —
 * in POST /api/issue the Plaid aggregate always overwrites `balance` before
 * signing, regardless of what the shorthand or `attributes` supplied.
 */
export const ATTRIBUTE_FIELD_BY_TYPE: Record<CredentialType, string | undefined> = {
  kyc: undefined,
  age: "date_of_birth",
  income: "income",
  jurisdiction: "country_code",
  funds: "balance",
  accreditation: "net_worth",
  employment: "seniority",
};

/**
 * Merge the single-value `attribute` shorthand into a full `attributes` map,
 * returning a new object (the input map is never mutated).
 *
 * - The shorthand only fills the type's field when that field is not already
 *   present in `attributes`, so an explicit `attributes` entry always wins.
 * - Unknown or missing `type` values apply no mapping and pass `attributes`
 *   through unchanged; rejecting invalid credential types is the caller's
 *   job (the issuance routes validate against CREDENTIAL_TYPES separately
 *   and may normalize before that check).
 */
export function normalizeAttributes(
  type: string | undefined,
  attribute: string | undefined,
  attributes: Record<string, string> = {},
): Record<string, string> {
  const normalized: Record<string, string> = { ...attributes };
  if (attribute === undefined || type === undefined) return normalized;
  // hasOwnProperty guard (not a plain index) so hostile type strings like
  // "constructor" or "toString" can't resolve an Object.prototype member.
  if (!Object.prototype.hasOwnProperty.call(ATTRIBUTE_FIELD_BY_TYPE, type)) return normalized;
  const field = ATTRIBUTE_FIELD_BY_TYPE[type as CredentialType];
  if (field === undefined) return normalized;
  normalized[field] ??= attribute;
  return normalized;
}
