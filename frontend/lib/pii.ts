// Canonical list of keys that must never be persisted, and the recursive
// stripper that enforces it.
//
// The security model (docs/THREAT_MODEL.md) is that identity attributes are
// not retained after the KYC provider call. Enforcement is a denylist applied
// at the last possible moment before serialization, which means *every*
// persistence path has to run it — the client-side Persona resume blob
// (lib/persona-pending.ts) and the server-side pending-inquiry context
// (lib/persona-webhook.ts) included. Defining the list once here is what
// stops the two from drifting apart, which is how identity data ends up
// persisted on one side and not the other.

/**
 * Keys that must never appear anywhere inside a serialized blob — neither
 * top-level nor nested. `attributes` is banned wholesale: every value it can
 * carry (date_of_birth, income, net_worth, country_code, seniority, balance)
 * is an identity attribute.
 */
export const PII_KEYS = [
  "attributes",
  "attribute",
  "first_name",
  "last_name",
  "id_number",
  "date_of_birth",
  "birthdate",
  "country_code",
  "income",
  "net_worth",
  "seniority",
  "balance",
] as const;

/**
 * Recursively remove any banned key from an arbitrary value. Caller-supplied
 * objects (protocol claimParams, query strings, request bodies) can carry
 * unexpected keys, so anything matching a banned key is dropped rather than
 * persisted.
 */
export function stripPiiKeys<T>(value: T): T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if ((PII_KEYS as readonly string[]).includes(key)) continue;
    out[key] = stripPiiKeys(child);
  }
  return out as T;
}
