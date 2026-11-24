// Attribute disclosure diff for the holder's proof-approval step (#1048).
//
// Before the browser starts generating a zero-knowledge proof, the holder is
// shown which parts of the credential the verifier will learn and which never
// leave this device. "The verifier" here means the ProofRegistry contract and
// anyone reading the chain: everything in `shared` is either a circuit public
// input or an argument of `submit_proof`, so it is public once submitted.
//
// The split mirrors each circuit's `pub` inputs (circuits/<type>_proof/src/
// main.nr) and `ProofRegistry::submit_proof` (contracts/proof_registry). If a
// circuit's public inputs change, update `typeSpecific` below to match.
//
// Pure functions only: no storage, network or prover access, so the diff is
// safe to compute before the holder has approved anything.

import type { CredentialType } from "./stellar";
import type { Credential } from "./credential";
import { buildClaimLabel } from "./credential-preview";
import { credTtlSecs } from "./proof-helpers";
import { truncateAddress, truncateHash } from "./format";

/** One row of the diff. */
export interface DisclosureItem {
  /** Stable key, unique within one credential's diff. */
  key: string;
  /** What the row is, e.g. "Date of birth". */
  label: string;
  /**
   * Display value. Set only on shared rows: private rows deliberately carry no
   * value, so a raw attribute can never be rendered by the preview.
   */
  value?: string;
  /** One line on why the row sits in its column. */
  detail: string;
}

/** The shared/private split for one credential. */
export interface DisclosureDiff {
  commitment: string;
  title: string;
  /** Disclosed to the verifier and recorded on-chain. */
  shared: DisclosureItem[];
  /** Used only inside the proof; never leaves this device. */
  kept: DisclosureItem[];
}

export interface DisclosureOptions {
  /** Connected wallet that will submit the proof. Falls back to `cred.holder`. */
  holder?: string;
  /** Clock for the age circuit's public `current_date`. Defaults to now. */
  now?: Date;
}

/**
 * The private attribute(s) each circuit takes. Labels match the issuer form
 * (TYPE_META in lib/credential.ts) so the holder sees the same names that
 * were attested.
 */
const PRIVATE_ATTRIBUTES: Record<CredentialType, DisclosureItem[]> = {
  kyc: [
    {
      key: "secret",
      label: "Identity secret",
      detail: "Random secret bound into your credential at issuance.",
    },
  ],
  age: [
    {
      key: "date_of_birth",
      label: "Date of birth",
      detail: "Only the result of the age check is proven.",
    },
  ],
  income: [
    {
      key: "income",
      label: "Annual income (USD)",
      detail: "Only that it clears the threshold is proven.",
    },
  ],
  jurisdiction: [
    {
      key: "country_code",
      label: "Country (ISO numeric)",
      detail: "Only whether it passes the country rule is proven.",
    },
  ],
  funds: [
    {
      key: "balance",
      label: "Aggregate balance across linked accounts (USD)",
      detail: "Only that it clears the threshold is proven.",
    },
  ],
  accreditation: [
    {
      key: "net_worth",
      label: "Net worth (USD)",
      detail: "Only that it clears the threshold is proven.",
    },
  ],
  employment: [
    {
      key: "employment_status",
      label: "Employment status",
      detail: "Only that you are employed is proven.",
    },
    {
      key: "seniority",
      label: "Seniority (years)",
      detail: "Only that it meets the minimum is proven.",
    },
  ],
};

/** Private inputs every credential circuit takes, whatever its type. */
const PRIVATE_COMMON: DisclosureItem[] = [
  {
    key: "salt",
    label: "Commitment salt",
    detail: "Random value that keeps the commitment from being guessed.",
  },
  {
    key: "issuer_signature",
    label: "Issuer signature",
    detail: "Checked inside the proof, never published.",
  },
];

/** Format a UTC calendar date as YYYY-MM-DD. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Public inputs that only some circuits have. */
function typeSpecific(cred: Credential, now: Date): DisclosureItem[] {
  switch (cred.type) {
    case "age":
      return [
        {
          key: "current_date",
          label: "Proof date",
          value: isoDate(now),
          detail: "Today's date, used to compute the age check.",
        },
      ];
    case "jurisdiction": {
      const count = cred.claimParams?.restricted?.length ?? 0;
      return [
        {
          key: "restricted",
          label: "Country list checked",
          value: count > 0 ? `${count} countr${count === 1 ? "y" : "ies"}` : "Default list",
          detail: "The list your country is checked against.",
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * Split one credential into what a proof discloses and what stays private.
 */
export function buildDisclosureDiff(
  cred: Credential,
  options: DisclosureOptions = {},
): DisclosureDiff {
  const now = options.now ?? new Date();
  const holder = options.holder || cred.holder;
  const days = Math.round(credTtlSecs(cred) / 86_400);

  const shared: DisclosureItem[] = [
    {
      key: "holder",
      label: "Wallet address",
      value: holder ? truncateAddress(holder) : "Not connected",
      detail: "The proof is recorded against this address.",
    },
    {
      key: "credential_type",
      label: "Credential type",
      value: cred.title,
      detail: "Selects the circuit the verifier checks.",
    },
    {
      key: "issuer",
      label: "Issuer",
      value: cred.issuer
        ? `${cred.issuer} (${truncateAddress(cred.issuerId)})`
        : truncateAddress(cred.issuerId),
      detail: "The verifier checks this issuer is trusted.",
    },
    {
      key: "claim",
      label: "Claim proven",
      value: buildClaimLabel(cred.type, cred.claimParams),
      detail: "The verifier learns only that this is true.",
    },
    ...typeSpecific(cred, now),
    {
      key: "commitment",
      label: "Commitment",
      value: truncateHash(cred.commitment),
      detail: "A one-way hash; it does not reveal the attribute.",
    },
    {
      key: "validity",
      label: "Proof validity",
      value: `${days} day${days === 1 ? "" : "s"}`,
      detail: "How long the on-chain proof record stays valid.",
    },
  ];

  const kept: DisclosureItem[] = [
    ...(PRIVATE_ATTRIBUTES[cred.type] ?? PRIVATE_ATTRIBUTES.kyc),
    ...PRIVATE_COMMON,
  ];

  return { commitment: cred.commitment, title: cred.title, shared, kept };
}
