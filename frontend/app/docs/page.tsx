import type { Metadata } from "next";
import DocsPageClient from "./DocsPageClient";

export const metadata: Metadata = {
  title: "StellarCred — Docs",
  description:
    "Learn the architecture, privacy model, and protocol flow behind zero-knowledge credentials on Stellar.",
};

export default function Page() {
  return <DocsPageClient />;
}
