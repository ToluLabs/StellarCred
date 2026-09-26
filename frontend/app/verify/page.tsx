import type { Metadata } from "next";
import VerifyPageClient from "./VerifyPageClient";

export const metadata: Metadata = {
  title: "StellarCred — Verify a claim",
  description: "Issue a zero-knowledge credential from a trusted issuer and prove your eligibility on Stellar.",
};

export default function Page() {
  return <VerifyPageClient />;
}
