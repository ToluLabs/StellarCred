// Circuit version identity for credentials (issue #633).
//
// A VK version alone does not say which circuit a credential belongs to. The
// VK is derived *from* a circuit and registered on-chain, so it only gains an
// identity at deploy time — long after a credential was minted. A holder
// credential carries value, salt, signature and commitment and nothing else,
// so there is no way to tell before proving whether the circuit currently
// served can still express it. When a circuit change alters the public-input
// layout, the only symptom is a failed proof: an opaque Noir witness error or,
// worse, a proof that verifies against the wrong VK.
//
// This module closes that gap with a *declared* circuit version:
//   circuits/circuit-versions.json      → the source of truth
//   compiled artifact (…/circuits/x.json) → stamped by circuits/scripts/build.sh
//   credential.circuitVersion            → recorded at issuance
//   the check below                      → run before every proof
//
// The table below mirrors the manifest. A unit test
// (lib/__tests__/circuit-versions.test.ts) asserts the two agree and that every
// compiled artifact carries the version declared here, so a bump on one side
// cannot silently drift from the other.
//
// Compatibility policy, matching the cross-deployment guard in lib/deployment:
// a credential that *records* a different circuit version is rejected, because
// the circuit that issued it is not one this build can prove with. A credential
// with no recorded version predates this field and is allowed through — it can
// only be diagnosed by attempting the proof, exactly as before.

import type { CredentialType } from "./stellar";

/**
 * A circuit the prover can run: any single-credential type, plus the
 * multi-credential `aggregate` circuit (not itself a credential type, but
 * compiled and served exactly like one). Mirrors `ProverCircuit` in
 * lib/proof.ts, which cannot be imported here without a cycle.
 */
export type VersionedCircuit = CredentialType | "aggregate";

/** Declared identity of one circuit. */
export interface CircuitVersion {
  /** Declared circuit version, `MAJOR.MINOR.PATCH`. */
  readonly version: string;
  /**
   * The `CredentialVerifier` VK counter for this circuit — the `version`
   * argument of `set_vk(credential_type, version, vk)`. Monotonic from 1; 0 is
   * reserved on-chain as the "version not stored" sentinel.
   */
  readonly vkVersion: number;
}

/**
 * The circuits this build can prove with, keyed by the name used on the wire
 * (the `<type>` in `/circuits/<type>.json` and the credential's `type`).
 *
 * Bump `version` in circuits/circuit-versions.json when a circuit change can
 * alter its public-input layout or the constraints it enforces — MAJOR for a
 * layout change, MINOR for added constraints, PATCH for a comment-only edit —
 * and bump `vkVersion` alongside it.
 */
export const CIRCUIT_VERSIONS: Readonly<Record<VersionedCircuit, CircuitVersion>> = {
  kyc: { version: "1.0.0", vkVersion: 1 },
  age: { version: "1.0.0", vkVersion: 1 },
  income: { version: "1.0.0", vkVersion: 1 },
  jurisdiction: { version: "1.0.0", vkVersion: 1 },
  funds: { version: "1.0.0", vkVersion: 1 },
  accreditation: { version: "1.0.0", vkVersion: 1 },
  employment: { version: "1.0.0", vkVersion: 1 },
  aggregate: { version: "1.0.0", vkVersion: 1 },
};

/**
 * The fields stamped onto a credential at issuance that record which circuit
 * can prove it. `circuitVkVersion` is redundant with `circuitVersion` while the
 * registry above is complete, but it is stored deliberately: the chain
 * credential → circuit → VK stays explicit on the credential itself, so it
 * still reads correctly if an older circuit version ever leaves the registry.
 */
export interface CircuitVersionStamp {
  circuitVersion?: string;
  circuitVkVersion?: number;
}

/** Declared identity for `type`, or null when this build has no such circuit. */
export function circuitVersionFor(type: string): CircuitVersion | null {
  return Object.prototype.hasOwnProperty.call(CIRCUIT_VERSIONS, type)
    ? CIRCUIT_VERSIONS[type as VersionedCircuit]
    : null;
}

/** The version to stamp on a newly issued `type` credential, or null if unknown. */
export function circuitVersionStampFor(type: string): CircuitVersionStamp {
  const declared = circuitVersionFor(type);
  return declared
    ? { circuitVersion: declared.version, circuitVkVersion: declared.vkVersion }
    : {};
}

/** Holder-facing name for a circuit type, e.g. `kyc` → "KYC". */
const TYPE_LABELS: Record<string, string> = {
  kyc: "KYC",
  age: "Age",
  income: "Income",
  jurisdiction: "Jurisdiction",
  funds: "Funds",
  accreditation: "Accreditation",
  employment: "Employment",
  aggregate: "Aggregate",
};

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Why a credential cannot be proven by the circuits this build serves, or null
 * when it can.
 *
 * Returns a message rather than a boolean so every caller — the import
 * boundary, the prove path, the witness API — reports the same explanation
 * instead of each inventing its own. Messages name the credential type, both
 * versions, and what the holder can actually do about it.
 */
export function circuitVersionMismatchMessage(
  type: string,
  recorded: unknown,
): string | null {
  // A credential with no recorded version predates circuit versioning. It is
  // not a mismatch: the proof simply has to be attempted, as it always was.
  if (typeof recorded !== "string" || recorded.length === 0) return null;

  const declared = circuitVersionFor(type);
  if (!declared) {
    return (
      `This ${typeLabel(type)} credential was issued against circuit version ` +
      `${recorded}, but this app has no "${type}" circuit to prove it with. ` +
      `Its circuit is no longer available.`
    );
  }

  if (recorded === declared.version) return null;

  return (
    `This ${typeLabel(type)} credential was issued against circuit version ` +
    `${recorded}, but this app proves with circuit version ${declared.version}. ` +
    `A circuit upgrade can change the inputs a credential needs, so this one ` +
    `cannot be proven with the circuits this app serves — it would fail as an ` +
    `invalid witness rather than a verification error. Ask the issuer to ` +
    `re-issue it against the current ${type} circuit.`
  );
}

/**
 * The circuit-compatibility verdict for a `/api/witness` request payload.
 *
 * A single-proof payload carries the credential as-is, so its recorded version
 * is read straight off. The aggregate payload is different: it has no `type` of
 * its own and flattens both inner credentials into prefixed keys, so each
 * version travels as `kyc_circuitVersion` / `age_circuitVersion`. The aggregate
 * circuit re-verifies the KYC and age claims itself, so each inner credential is
 * checked against the circuit that will actually re-verify it.
 *
 * Returns null when the payload carries no recorded version anywhere — same
 * legacy policy as everywhere else.
 */
export function witnessCircuitVersionMismatch(
  type: string,
  payload: Record<string, unknown>,
): string | null {
  if (type === "aggregate") {
    return (
      circuitVersionMismatchMessage("kyc", payload.kyc_circuitVersion) ??
      circuitVersionMismatchMessage("age", payload.age_circuitVersion)
    );
  }
  return circuitVersionMismatchMessage(type, payload.circuitVersion);
}

/**
 * Build the error thrown when a proof is attempted against an incompatible
 * circuit. Carries a stable `code` so callers (and the API route) can
 * distinguish it from a generic Noir failure.
 */
export class CircuitVersionMismatchError extends Error {
  readonly code = "circuit_version_mismatch";

  constructor(message: string) {
    super(message);
    this.name = "CircuitVersionMismatchError";
  }
}

/**
 * Throws when `credential` records a circuit version this build cannot prove.
 *
 * Called before witness generation on every proof path (single and aggregate),
 * so a credential issued against a superseded circuit fails immediately with an
 * explanation instead of producing an invalid witness.
 */
export function assertCredentialCircuitCompatible(
  credential: CircuitVersionStamp & { type?: unknown },
  typeOverride?: string,
): void {
  const type = typeOverride ?? (typeof credential.type === "string" ? credential.type : "");
  if (!type) return;
  const mismatch = circuitVersionMismatchMessage(type, credential.circuitVersion);
  if (mismatch) throw new CircuitVersionMismatchError(mismatch);
}
