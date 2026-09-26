export interface DocSubSection {
  id: string;
  title: string;
  content: string;
}

export interface DocSection {
  id: string;
  title: string;
  subsections?: DocSubSection[];
  content?: string;
}

export const docsSections: DocSection[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    subsections: [
      {
        id: "overview",
        title: "Overview",
        content: "Welcome to StellarCred. StellarCred provides decentralized credit scoring and verification mechanisms built on top of the Stellar network."
      },
      {
        id: "quickstart",
        title: "Quickstart",
        content: "To get started, connect your Stellar wallet (Freighter or Lobstr) and complete your initial credit assessment profile."
      }
    ]
  },
  {
    id: "core-concepts",
    title: "Core Concepts",
    subsections: [
      {
        id: "credit-score",
        title: "Credit Scoring",
        content: "Credit scores are computed on-chain utilizing Soroban smart contract logic based on transactional history, account age, and liquidity reserves."
      },
      {
        id: "verification",
        title: "Verification",
        content: "Verifications allow third parties to attest to credentials without exposing sensitive personal identifiers."
      }
    ]
  }
];
