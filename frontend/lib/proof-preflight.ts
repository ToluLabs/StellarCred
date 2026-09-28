import type { Credential } from "./credential";

export type ProofPreflightWarningCode =
  | "below-threshold"
  | "jurisdiction-denied"
  | "credential-expired";

export interface ProofPreflightWarning {
  code: ProofPreflightWarningCode;
  message: string;
}

function numeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function ageInYears(dateOfBirth: string, now = new Date()): number | null {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) || Number.isNaN(dob.getTime())) return null;
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) years -= 1;
  return years;
}

/**
 * Convenience-only local check. The circuit remains authoritative; callers
 * must present an explicit way to continue when this reports a warning.
 */
export function getProofPreflightWarnings(
  cred: Credential,
  now = new Date(),
): ProofPreflightWarning[] {
  const warnings: ProofPreflightWarning[] = [];
  const params = cred.claimParams ?? {};

  if (cred.issuedAt + parseTtlSecs(cred.expiry) <= Math.floor(now.getTime() / 1000)) {
    warnings.push({
      code: "credential-expired",
      message: `This credential expired on ${new Date((cred.issuedAt + parseTtlSecs(cred.expiry)) * 1000).toLocaleDateString("en-GB")}.`,
    });
  }

  if (cred.type === "age") {
    const actual = ageInYears(cred.value, now);
    const required = numeric(params.threshold_years ?? 18);
    if (actual !== null && required !== null && actual < required) {
      warnings.push({
        code: "below-threshold",
        message: `Your credential shows age ${actual}, below the requested minimum of ${formatNumber(required)} years.`,
      });
    }
  } else if (["income", "funds", "accreditation", "employment"].includes(cred.type)) {
    const actual = numeric(cred.value);
    const defaults: Record<string, number> = {
      income: 200_000,
      funds: 10_000,
      accreditation: 1_000_000,
      employment: 3,
    };
    const required = numeric(params.threshold ?? defaults[cred.type]);
    const strictGreaterThan = cred.type === "income" || cred.type === "funds";
    const unsatisfied = strictGreaterThan
      ? actual !== null && required !== null && actual <= required
      : actual !== null && required !== null && actual < required;
    if (unsatisfied && actual !== null && required !== null) {
      const label = cred.type === "employment" ? "years of seniority" : "value";
      warnings.push({
        code: "below-threshold",
        message: `Your credential's ${label} (${formatNumber(actual)}) is below the requested minimum of ${formatNumber(required)}.`,
      });
    }
  } else if (cred.type === "jurisdiction") {
    const country = String(cred.value);
    const restricted = (params.restricted ?? []).map(String);
    const denied = params.mode === "1" ? !restricted.includes(country) : restricted.includes(country);
    if (denied) {
      warnings.push({
        code: "jurisdiction-denied",
        message: params.mode === "1"
          ? `Your jurisdiction (${country}) is not on the requested allowed-country list.`
          : `Your jurisdiction (${country}) is on the requested restricted-country list.`,
      });
    }
  }

  return warnings;
}

function parseTtlSecs(expiry: string): number {
  const match = expiry?.match(/(\d+)/);
  return (match ? parseInt(match[1], 10) : 30) * 86_400;
}
