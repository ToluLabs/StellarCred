import type { Metadata } from "next";
import AppsPageClient from "./AppsPageClient";

export const metadata: Metadata = {
  title: "StellarCred — Protocols",
  description:
    "Browse live demo protocols that gate access with zero-knowledge credentials on Stellar.",
};

export default function Page() {
  return <AppsPageClient />;
}
