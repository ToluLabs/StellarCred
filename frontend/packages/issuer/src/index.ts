// @stellarcred/issuer — server-only credential issuance.
//
// Wraps the full StellarCred issuance pipeline: attribute -> circuit value,
// salt generation, Poseidon2 commitment (matching the Noir circuits and the
// on-chain verifier), and a secp256k1 signature over the raw commitment
// (prehash: false — Noir uses the 32-byte digest directly, no SHA-256
// pre-hash step).
//
// This module signs with a private key and must never run in a browser. The
// package.json "exports" field only defines a "node" condition, so bundlers
// that respect package exports will fail to resolve this import outside
// Node.js. This runtime check is defense-in-depth for older tooling that
// ignores exports conditions.
if (typeof window !== "undefined") {
  throw new Error(
    "@stellarcred/issuer must only be used server-side. It signs credentials " +
      "with a private key and must never run in a browser.",
  );
}

import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
// Copied from public/circuits/commit.json by scripts/sync-circuit.mjs (prebuild).
import commitCircuit from "./commit-circuit.json";

export const CREDENTIAL_TYPES = [
  "kyc",
  "age",
  "jurisdiction",
  "income",
  "funds",
  "accreditation",
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export interface ClaimParams {
  threshold_years?: string;
  threshold?: string;
  restricted?: string[];
}

export interface Credential {
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
  claimParams?: ClaimParams;
}

export interface IssueParams {
  type: CredentialType;
  holder: string;
  issuerId: string;
  issuerName: string;
  /** Either a duration string ("90 days") or an absolute unix timestamp. */
  expiry: string | number;
  /** Type-specific attribute fields, e.g. { date_of_birth: "1990-01-01" }. */
  attribute: Record<string, string>;
  claimParams?: ClaimParams;
}

export interface IssuerClientOptions {
  /** 64-character hex secp256k1 private key. Server-side only — never NEXT_PUBLIC_. */
  privateKey: string;
}

function be32(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
}

function randomField(): string {
  // 31 bytes = 248 bits, always fits in BN254 scalar field.
  return "0x" + randomBytes(31).toString("hex");
}

// Derive the circuit `value` (preimage) for a credential type from the
// caller-supplied attribute fields.
function attributeToValue(type: CredentialType, attribute: Record<string, string>): string {
  switch (type) {
    case "kyc":
      // Binary claim — no attribute to commit, just a fresh random secret.
      return randomField();
    case "age": {
      const dob = attribute.date_of_birth;
      if (!dob) throw new Error("age credential requires attribute.date_of_birth");
      const days = Math.floor(new Date(dob).getTime() / 86_400_000);
      if (!Number.isFinite(days) || days < 0)
        throw new Error("Invalid date_of_birth: must be on or after 1970-01-01");
      return String(days);
    }
    case "income": {
      const income = parseInt(attribute.income ?? "", 10);
      if (!Number.isFinite(income) || income < 0) throw new Error("income credential requires a non-negative attribute.income");
      return String(income);
    }
    case "jurisdiction": {
      const country = parseInt(attribute.country_code ?? "", 10);
      if (!Number.isFinite(country)) throw new Error("jurisdiction credential requires attribute.country_code");
      return String(country);
    }
    case "funds": {
      const balance = parseInt(attribute.balance ?? "", 10);
      if (!Number.isFinite(balance)) throw new Error("funds credential requires attribute.balance");
      return String(balance);
    }
    case "accreditation": {
      const netWorth = parseInt(attribute.net_worth ?? "", 10);
      if (!Number.isFinite(netWorth)) throw new Error("accreditation credential requires attribute.net_worth");
      return String(netWorth);
    }
    default:
      throw new Error(`Unknown credential type: ${type as string}`);
  }
}

async function poseidonCommit(value: string, salt: string): Promise<string> {
  const { Noir } = await import("@noir-lang/noir_js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noir = new Noir(commitCircuit as any);
  const { returnValue } = await noir.execute({ value, salt });
  return String(returnValue);
}

function issuerPublicKey(privateKey: Uint8Array): { x: number[]; y: number[] } {
  const p = secp256k1.getPublicKey(privateKey, false); // 0x04 || x || y
  return { x: Array.from(p.slice(1, 33)), y: Array.from(p.slice(33, 65)) };
}

function signCommitment(
  commitment: string,
  privateKey: Uint8Array,
): { sig: number[]; issuerX: number[]; issuerY: number[] } {
  const sig = secp256k1.sign(be32(BigInt(commitment)), privateKey, { prehash: false });
  const { x, y } = issuerPublicKey(privateKey);
  return { sig: Array.from(sig), issuerX: x, issuerY: y };
}

const TYPE_TITLE: Record<CredentialType, string> = {
  kyc: "KYC Complete",
  age: "Age Verified",
  income: "Accredited (Income)",
  jurisdiction: "Jurisdiction Eligible",
  funds: "Proof of Funds",
  accreditation: "Accredited Investor (Net Worth)",
};

function buildClaimLabel(type: CredentialType, claimParams?: ClaimParams): string {
  switch (type) {
    case "age":
      return `age ≥ ${claimParams?.threshold_years ?? "18"}`;
    case "income": {
      const t = Number(claimParams?.threshold ?? "200000");
      return `income > $${t.toLocaleString("en-US")}`;
    }
    case "funds": {
      const t = Number(claimParams?.threshold ?? "10000");
      return `balance > $${t.toLocaleString("en-US")}`;
    }
    case "accreditation": {
      const t = Number(claimParams?.threshold ?? "1000000");
      return `net worth ≥ $${t.toLocaleString("en-US")}`;
    }
    case "jurisdiction":
      return "country not restricted";
    case "kyc":
    default:
      return "identity verified";
  }
}

// Normalize expiry to the "N days" string convention every Credential uses.
// A caller-supplied duration string passes through unchanged; a unix
// timestamp is converted relative to issuedAt.
function normalizeExpiry(expiry: string | number, issuedAt: number): string {
  if (typeof expiry === "string") return expiry;
  const days = Math.max(1, Math.round((expiry - issuedAt) / 86_400));
  return `${days} days`;
}

function parsePrivateKey(privateKey: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(
      "IssuerClient requires a 64-character hex secp256k1 private key (set ISSUER_PRIVATE_KEY server-side, never NEXT_PUBLIC_)",
    );
  }
  return Uint8Array.from(Buffer.from(privateKey, "hex"));
}

export class IssuerClient {
  private readonly privateKey: Uint8Array;

  constructor(opts: IssuerClientOptions) {
    this.privateKey = parsePrivateKey(opts?.privateKey);
  }

  /** The issuer's secp256k1 public key — register this with IssuerRegistry. */
  publicKey(): { x: number[]; y: number[] } {
    return issuerPublicKey(this.privateKey);
  }

  /**
   * Issue one credential. Every call produces its own independent
   * preimage/salt/commitment/signature — nothing is shared across calls but
   * the issuer key.
   */
  async issue(params: IssueParams): Promise<Credential> {
    const { type, holder, issuerId, issuerName, expiry, attribute, claimParams } = params;
    if (!CREDENTIAL_TYPES.includes(type)) {
      throw new Error(`Unknown credential type: ${type as string}`);
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const value = attributeToValue(type, attribute);
    const salt = randomField();
    const commitment = await poseidonCommit(value, salt);
    const { sig, issuerX, issuerY } = signCommitment(commitment, this.privateKey);
    return {
      type,
      title: TYPE_TITLE[type],
      claim: buildClaimLabel(type, claimParams),
      issuer: issuerName,
      issuerId,
      holder,
      value,
      salt,
      commitment,
      sig,
      issuerPubX: issuerX,
      issuerPubY: issuerY,
      issuedAt,
      expiry: normalizeExpiry(expiry, issuedAt),
      ...(claimParams && Object.values(claimParams).some((v) => v !== undefined) ? { claimParams } : {}),
    };
  }
}
