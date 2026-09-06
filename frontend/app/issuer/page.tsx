import type { Metadata } from "next";
import IssuerPageClient from "./IssuerPageClient";

export const metadata: Metadata = {
  title: "StellarCred — Issue credentials",
  description: "Demo issuer flow for issuing attested zero-knowledge credentials to a wallet on Stellar.",
};

export default function Page() {
  return <IssuerPageClient />;
}
