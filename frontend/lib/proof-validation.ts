import type { Credential } from "./credential";

const EXPECTED_FIELD_COUNTS: Record<Credential["type"], number> = {
  kyc: 65,
  age: 67,
  income: 66,
  funds: 66,
  accreditation: 66,
  employment: 66,
  jurisdiction: 74,
};

const DEFAULT_THRESHOLDS: Partial<Record<Credential["type"], string>> = {
  age: "18",
  income: "200000",
  funds: "10000",
  accreditation: "1000000",
  employment: "3",
};

function parseField(field: unknown): bigint | null {
  if (typeof field !== "string" || !/^(0x[0-9a-f]+|[0-9]+)$/i.test(field)) return null;
  try {
    return BigInt(field);
  } catch {
    return null;
  }
}

export function decodeProofBytes(value: unknown, label: string): Uint8Array {
  if (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return Uint8Array.from(value as number[]);
  }
  if (typeof value === "string") {
    if (/^(0x)?(?:[0-9a-f]{2})+$/i.test(value)) {
      return Uint8Array.from(Buffer.from(value.replace(/^0x/i, ""), "hex"));
    }
    if (value.startsWith("base64:")) {
      return Uint8Array.from(Buffer.from(value.slice(7), "base64"));
    }
  }
  throw new Error(`${label} must be a byte array, an even-length hex string, or a base64: string.`);
}

export function decodeProofFields(value: unknown): string[] {
  if (Array.isArray(value) && value.every((field) => typeof field === "string")) {
    return value as string[];
  }
  const bytes = decodeProofBytes(value, "publicInputs");
  if (bytes.length % 32 !== 0) {
    throw new Error(
      `publicInputs has ${bytes.length} bytes; expected complete 32-byte field elements.`,
    );
  }
  const fields: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32) {
    fields.push(`0x${Buffer.from(bytes.slice(offset, offset + 32)).toString("hex")}`);
  }
  return fields;
}

function publicInputByte(fields: string[], index: number): bigint | null {
  const value = parseField(fields[index]);
  return value !== null && value <= 255n ? value : null;
}

export function validateClaimInputs(credential: Credential, fields: string[]): string[] {
  const errors: string[] = [];
  const expectedCount = EXPECTED_FIELD_COUNTS[credential.type];
  if (fields.length !== expectedCount) {
    return [
      `Expected ${expectedCount} public inputs for ${credential.type}, got ${fields.length}. Check that the proof and circuit type match.`,
    ];
  }

  const commitment = parseField(credential.commitment);
  if (commitment === null || parseField(fields[0]) !== commitment) {
    errors.push("Proof commitment does not match the credential commitment.");
  }

  for (let index = 0; index < 64; index += 1) {
    const expected = BigInt(
      index < 32 ? credential.issuerPubX[index] : credential.issuerPubY[index - 32],
    );
    if (publicInputByte(fields, index + 1) !== expected) {
      errors.push("Proof issuer public key does not match the credential issuer key.");
      break;
    }
  }

  const thresholdIndex = credential.type === "age" ? 66 : 65;
  const thresholdName = credential.type === "age" ? "threshold_years" : "threshold";
  const thresholdDefault = DEFAULT_THRESHOLDS[credential.type];
  if (thresholdDefault) {
    const expectedRaw = credential.claimParams?.[thresholdName] ?? thresholdDefault;
    if (!/^\d+$/.test(expectedRaw)) {
      errors.push(`Credential ${thresholdName} must be a non-negative integer.`);
    } else if (parseField(fields[thresholdIndex]) !== BigInt(expectedRaw)) {
      errors.push(
        `Proof ${thresholdName} does not match the credential claim policy (${expectedRaw}).`,
      );
    }
  }

  if (credential.type === "jurisdiction") {
    const restricted = credential.claimParams?.restricted ?? [];
    if (restricted.length > 8 || restricted.some((code) => !/^\d{1,3}$/.test(code))) {
      errors.push("Credential restricted list must contain at most 8 numeric ISO country codes.");
    } else {
      const expected = [...restricted.map(BigInt), ...Array(8 - restricted.length).fill(0n)];
      for (let index = 0; index < 8; index += 1) {
        if (parseField(fields[65 + index]) !== expected[index]) {
          errors.push("Proof restricted list does not match the credential claim policy.");
          break;
        }
      }
      const expectedMode = credential.claimParams?.mode ?? "0";
      if (
        (expectedMode !== "0" && expectedMode !== "1") ||
        parseField(fields[73]) !== BigInt(expectedMode)
      ) {
        errors.push(
          "Proof jurisdiction mode does not match the credential claim policy (0=denylist, 1=allowlist).",
        );
      }
    }
  }

  return errors;
}
