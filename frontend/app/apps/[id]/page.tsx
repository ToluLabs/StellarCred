import type { Metadata } from "next";
import { Suspense } from "react";
import { getProtocol } from "@/lib/protocols";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const protocol = getProtocol(id);
  if (!protocol) {
    return {
      title: "StellarCred — Protocol not found",
      description: "The requested StellarCred protocol could not be found.",
    };
  }

  return {
    title: `StellarCred — ${protocol.name}`,
    description: protocol.tagline,
    openGraph: {
      title: `StellarCred — ${protocol.name}`,
      description: protocol.tagline,
      siteName: "StellarCred",
      type: "website",
    },
    twitter: {
      card: "summary",
      title: `StellarCred — ${protocol.name}`,
      description: protocol.tagline,
    },
  };
}

import ProtocolDetailClient from "./ProtocolDetailClient";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <ProtocolDetailClient id={id} />
    </Suspense>
  );
}
