import type { Metadata } from "next";
import PresetsPageClient from "./PresetsPageClient";

export const metadata: Metadata = {
  title: "Selective disclosure presets — StellarCred",
  description:
    "Create and manage selective disclosure presets for StellarCred credentials. Bundle claim types into named presets for streamlined verification.",
};

export default function PresetsPage() {
  return <PresetsPageClient />;
}
