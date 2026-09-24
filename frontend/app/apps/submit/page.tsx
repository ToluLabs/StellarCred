import type { Metadata } from "next";
import SubmitAppPageClient from "./SubmitAppPageClient";

export const metadata: Metadata = {
  title: "StellarCred — Submit an App",
  description:
    "Submit your StellarCred integration for review and listing in the Apps gallery.",
};

export default function Page() {
  return <SubmitAppPageClient />;
}
