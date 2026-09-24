import type { Metadata } from "next";
import HolderPageClient from "./HolderPageClient";

export const metadata: Metadata = {
  title: "StellarCred — Your credentials",
  description: "Manage verified zero-knowledge credentials held in your wallet and prove them on-chain.",
};

export default function Page() {
  return <HolderPageClient />;
}
