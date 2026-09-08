import {
  IconBuildingBank,
  IconCoin,
  IconId,
  IconWorld,
  IconTrendingUp,
  IconCurrencyDollar,
  IconGift,
} from "@tabler/icons-react";

export interface Requirement {
  label: string;
  type: string;
  minThreshold?: number;
}

/**
 * Nullifier-gated distribution config (see `contracts/human_airdrop`). When a
 * protocol carries this, the app page renders the one-claim-per-human demo.
 */
export interface AirdropCampaign {
  /** `campaign_id` Symbol passed to `human_airdrop.claim`. */
  campaignId: string;
  /** App scope hashed into every nullifier for this campaign. */
  scope: string;
  /** Per-human allocation, formatted for display. */
  amountLabel: string;
  /** Credential the campaign requires. */
  credentialType: string;
}

export interface Protocol {
  id: string;
  name: string;
  tagline: string;
  description: string;
  stat: { label: string; value: string; sub: string };
  requirements: Requirement[];
  verifyUrl: string;
  actionLabel: string;
  inputLabel: string;
  inputDefault: string;
  icon: React.ReactNode;
  /** Present on nullifier-gated, one-claim-per-human distributions. */
  airdrop?: AirdropCampaign;
}

export const PROTOCOLS: Protocol[] = [
  {
    id: "humandrop",
    name: "HumanDrop",
    tagline: "One-Claim-Per-Human Airdrop",
    description:
      "A Sybil-resistant token distribution. Eligibility is a KYC proof, but the anti-Sybil guarantee comes from a campaign-scoped nullifier derived from the credential itself — so one human claims exactly once, however many wallets they fund.",
    stat: { label: "Allocation per human", value: "250 XLM", sub: "4,000 humans · one claim each" },
    requirements: [{ label: "KYC verified", type: "kyc" }],
    verifyUrl: "/verify?return_url=/apps/humandrop&claim=kyc",
    actionLabel: "Claim airdrop",
    inputLabel: "Allocation (XLM)",
    inputDefault: "250",
    icon: <IconGift size={18} stroke={1.6} />,
    airdrop: {
      campaignId: "drop1",
      scope: "stellarcred:airdrop:humandrop-2026",
      amountLabel: "250 XLM",
      credentialType: "kyc",
    },
  },
  {
    id: "lendfi",
    name: "LendFi",
    tagline: "Institutional DeFi Lending",
    description:
      "Undercollateralised lending for verified institutional participants. Requires full KYC, age, and accreditation proofs.",
    stat: { label: "Total value locked", value: "$124,800", sub: "USDC · stellar:testnet" },
    requirements: [
      { label: "KYC verified",       type: "kyc" },
      { label: "Age ≥ 18",           type: "age",    minThreshold: 18 },
      { label: "Accredited investor", type: "income", minThreshold: 200000 },
    ],
    verifyUrl: "/verify?return_url=/apps/lendfi&claim=kyc",
    actionLabel: "Deposit",
    inputLabel: "Amount (USDC)",
    inputDefault: "5,000",
    icon: <IconBuildingBank size={18} stroke={1.6} />,
  },
  {
    id: "agegate",
    name: "AgeGate",
    tagline: "21+ Regulated Markets",
    description:
      "Access to regulated derivatives and structured products restricted to verified adults. Age is proved from a ZK commitment — your date of birth is never revealed.",
    stat: { label: "Eligible instruments", value: "47", sub: "regulated derivatives" },
    requirements: [
      { label: "Age ≥ 21",    type: "age", minThreshold: 21 },
      { label: "KYC verified", type: "kyc" },
    ],
    verifyUrl: "/verify?return_url=/apps/agegate&claim=age&threshold_years=21",
    actionLabel: "Access markets",
    inputLabel: "Notional value (USD)",
    inputDefault: "25,000",
    icon: <IconId size={18} stroke={1.6} />,
  },
  {
    id: "fundvault",
    name: "FundVault",
    tagline: "Institutional Yield Pool",
    description:
      "Fixed-rate yield vault for participants who can prove minimum liquid reserves. Balance is verified directly from your bank — nothing is disclosed on-chain.",
    stat: { label: "Current APY", value: "8.4%", sub: "30-day trailing average" },
    requirements: [{ label: "Balance ≥ $10,000", type: "funds", minThreshold: 10000 }],
    verifyUrl: "/verify?return_url=/apps/fundvault&claim=funds&threshold=10000",
    actionLabel: "Deposit",
    inputLabel: "Amount (USDC)",
    inputDefault: "10,000",
    icon: <IconCoin size={18} stroke={1.6} />,
  },
  {
    id: "borderfi",
    name: "BorderFi",
    tagline: "Cross-Border Transfers",
    description:
      "Compliant cross-border payment rails for verified, non-sanctioned participants. Jurisdiction is proved in zero-knowledge — your country is never revealed on-chain.",
    stat: { label: "Daily volume", value: "$2.1M", sub: "USDC · 38 corridors" },
    requirements: [
      { label: "KYC verified",          type: "kyc" },
      { label: "Jurisdiction eligible", type: "jurisdiction" },
    ],
    verifyUrl: "/verify?return_url=/apps/borderfi&claim=kyc",
    actionLabel: "Send funds",
    inputLabel: "Amount (USDC)",
    inputDefault: "1,000",
    icon: <IconWorld size={18} stroke={1.6} />,
  },
  {
    id: "yieldmax",
    name: "YieldMax",
    tagline: "Premium Yield Vault",
    description:
      "High-yield fixed-income vault restricted to participants with verified liquid reserves above $50,000. Your exact balance is never disclosed — only the threshold.",
    stat: { label: "Current APY", value: "12.7%", sub: "90-day trailing average" },
    requirements: [
      { label: "KYC verified",      type: "kyc" },
      { label: "Balance ≥ $50,000", type: "funds", minThreshold: 50000 },
    ],
    verifyUrl: "/verify?return_url=/apps/yieldmax&claim=funds&threshold=50000",
    actionLabel: "Deposit",
    inputLabel: "Amount (USDC)",
    inputDefault: "50,000",
    icon: <IconTrendingUp size={18} stroke={1.6} />,
  },
  {
    id: "tradepro",
    name: "TradePro",
    tagline: "Institutional Trading Desk",
    description:
      "Derivatives and structured products for verified high-net-worth traders. Requires KYC, accredited-investor status, and age verification.",
    stat: { label: "Open interest", value: "$8.3M", sub: "perpetuals · options" },
    requirements: [
      { label: "KYC verified",       type: "kyc" },
      { label: "Age ≥ 18",           type: "age",    minThreshold: 18 },
      { label: "Income ≥ $500,000",  type: "income", minThreshold: 500000 },
    ],
    verifyUrl: "/verify?return_url=/apps/tradepro&claim=kyc",
    actionLabel: "Start trading",
    inputLabel: "Notional value (USD)",
    inputDefault: "100,000",
    icon: <IconCurrencyDollar size={18} stroke={1.6} />,
  },
];

export function getProtocol(id: string): Protocol | undefined {
  return PROTOCOLS.find((p) => p.id === id);
}
