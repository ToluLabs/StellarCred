export interface UniquenessAttestationInput {
  wallet: string;
  campaignId: string;
  scope: "airdrop" | "quota" | "leaderboard" | string;
  epoch?: string | number;
  issuer?: string;
}

export interface UniquenessAttestation {
  version: 1;
  wallet: string;
  campaignId: string;
  scope: string;
  epoch: string | null;
  issuer: string | null;
  nullifier: string;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

async function sha256Hex(payload: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  }
  const encoded = new TextEncoder().encode(payload);
  const digest = await subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalizeUniquenessPayload(input: UniquenessAttestationInput): string {
  return canonicalize({
    campaignId: input.campaignId.trim(),
    epoch: input.epoch === undefined ? null : String(input.epoch),
    issuer: input.issuer?.trim() || null,
    scope: input.scope.trim(),
    wallet: input.wallet.trim(),
  });
}

export async function createUniquenessAttestation(
  input: UniquenessAttestationInput,
): Promise<UniquenessAttestation> {
  const payload = canonicalizeUniquenessPayload(input);
  return {
    version: 1,
    wallet: input.wallet.trim(),
    campaignId: input.campaignId.trim(),
    scope: input.scope.trim(),
    epoch: input.epoch === undefined ? null : String(input.epoch),
    issuer: input.issuer?.trim() || null,
    nullifier: await sha256Hex(`stellarcred:uniqueness:v1:${payload}`),
  };
}

export function sameUniquenessSubject(
  left: Pick<UniquenessAttestation, "campaignId" | "scope" | "epoch" | "issuer">,
  right: Pick<UniquenessAttestation, "campaignId" | "scope" | "epoch" | "issuer">,
): boolean {
  return (
    left.campaignId === right.campaignId &&
    left.scope === right.scope &&
    left.epoch === right.epoch &&
    left.issuer === right.issuer
  );
}
