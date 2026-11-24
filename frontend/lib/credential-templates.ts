import type { CredentialType } from "./stellar";

export interface CredentialTemplate {
  id: string;
  name: string;
  description: string;
  badge: string;
  type: CredentialType;
  defaultAttribute: string;
  defaultExpiry: string;
  category: "finance" | "compliance" | "identity" | "work";
}

export const CREDENTIAL_TEMPLATES: CredentialTemplate[] = [
  {
    id: "accredited-investor",
    name: "Accredited Investor ($1M+)",
    description: "Qualifies holder for private placements with net worth >= $1,000,000.",
    badge: "$1M+ Net Worth",
    type: "accreditation",
    defaultAttribute: "1000000",
    defaultExpiry: "365 days",
    category: "finance",
  },
  {
    id: "age-18",
    name: "Age 18+ (Adult)",
    description: "Standard age-gate verification for adult legal capacity.",
    badge: "Age >= 18",
    type: "age",
    defaultAttribute: "2005-01-01",
    defaultExpiry: "365 days",
    category: "compliance",
  },
  {
    id: "age-21",
    name: "Age 21+ (Legal Age)",
    description: "Enforces 21+ legal age threshold for regulated products and venues.",
    badge: "Age >= 21",
    type: "age",
    defaultAttribute: "2002-01-01",
    defaultExpiry: "365 days",
    category: "compliance",
  },
  {
    id: "eu-resident",
    name: "EU Resident (Germany - 276)",
    description: "Proof of residence in European Union member state (ISO country code 276).",
    badge: "EU (DE 276)",
    type: "jurisdiction",
    defaultAttribute: "276",
    defaultExpiry: "180 days",
    category: "compliance",
  },
  {
    id: "proof-of-funds-50k",
    name: "Proof of Funds >= $50,000",
    description: "Liquid funds balance threshold for DeFi protocols or collateral tiers.",
    badge: "$50k+ Liquid",
    type: "funds",
    defaultAttribute: "50000",
    defaultExpiry: "30 days",
    category: "finance",
  },
  {
    id: "high-income",
    name: "High Income ($200k+)",
    description: "Annual verified income threshold of at least $200,000.",
    badge: "$200k+ Income",
    type: "income",
    defaultAttribute: "200000",
    defaultExpiry: "180 days",
    category: "finance",
  },
  {
    id: "standard-kyc",
    name: "Standard KYC Verified",
    description: "Full identity verification check via government ID and biometric selfie.",
    badge: "KYC Verified",
    type: "kyc",
    defaultAttribute: "",
    defaultExpiry: "90 days",
    category: "identity",
  },
  {
    id: "senior-employment",
    name: "Senior Employment (3+ Years)",
    description: "Verified employer tenure of 3 or more years.",
    badge: "3+ Yrs Tenure",
    type: "employment",
    defaultAttribute: "3",
    defaultExpiry: "180 days",
    category: "work",
  },
];

export function getTemplatesByType(type: CredentialType): CredentialTemplate[] {
  return CREDENTIAL_TEMPLATES.filter((t) => t.type === type);
}

export function getTemplateById(id: string): CredentialTemplate | undefined {
  return CREDENTIAL_TEMPLATES.find((t) => t.id === id);
}
