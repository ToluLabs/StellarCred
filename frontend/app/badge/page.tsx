import type { Metadata } from "next";
import BadgePageClient from "./BadgePageClient";

export const metadata: Metadata = {
  title: "StellarCred — Verification Badge",
  description:
    "Embeddable on-chain verification badge for StellarCred credentials.",
};

export default function Page() {
  return <BadgePageClient />;
}
