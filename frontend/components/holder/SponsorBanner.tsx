"use client";

import { IconBolt } from "@tabler/icons-react";
import { isSponsorAvailable } from "@/lib/sponsor";

/**
 * Banner shown on the holder page when the gasless / sponsored submission
 * relay is configured. Tells the user they can submit proofs without XLM.
 */
export function SponsorBanner() {
  if (!isSponsorAvailable()) return null;

  return (
    <div
      style={{
        padding: "0.65rem 0.9rem",
        borderRadius: "var(--radius)",
        background: "rgba(99,162,255,0.06)",
        border: "1px solid rgba(99,162,255,0.2)",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        fontSize: "0.8125rem",
        color: "var(--text)",
      }}
    >
      <IconBolt size={15} stroke={2} style={{ color: "#63a2ff", flexShrink: 0 }} />
      <span>
        <strong>Gasless submission available.</strong>{" "}
        You can submit proofs without XLM — fees are covered by the protocol.
      </span>
    </div>
  );
}
