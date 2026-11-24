"use client";

import { WalletButton } from "@/components/WalletButton";

export function VerifyHeader() {
  return (
    <div className="between" style={{ marginBottom: "2rem" }}>
      <div>
        <span className="eyebrow">Verify</span>
        <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>
          Get verified
        </h1>
      </div>
      <WalletButton />
    </div>
  );
}
