"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { IconCheck, IconX, IconLoader2 } from "@tabler/icons-react";
import { truncateHash } from "@/lib/format";
import { isVerified } from "@/lib/contracts";

function BadgeContent() {
  const searchParams = useSearchParams();
  const wallet = searchParams.get("wallet") || "";
  const claim = searchParams.get("claim") || searchParams.get("type") || "kyc";
  // "auto" (the default) matches the host page's OS-level color scheme —
  // this badge is meant to be embedded via <iframe> on someone else's site,
  // so it has no way to see *that* page's own light/dark toggle, but
  // matching the visitor's OS preference is the closest reasonable default.
  // Matches buildBadgeUrl(), which only sets ?theme= for an explicit choice.
  const theme = searchParams.get("theme") || "auto";
  const isCompact = searchParams.get("compact") === "1" || searchParams.get("compact") === "true";

  const [verified, setVerified] = useState<boolean | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [prefersDark, setPrefersDark] = useState(false);

  useEffect(() => {
    if (theme !== "auto" || typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    setPrefersDark(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    if (!wallet) {
      setLoading(false);
      setVerified(false);
      return;
    }

    let isMounted = true;
    async function checkStatus() {
      try {
        setLoading(true);
        const result = await isVerified(wallet, claim);
        if (isMounted) {
          setVerified(result.valid);
          setLoading(false);
        }
      } catch (err) {
        console.error("Badge verification lookup failed:", err);
        if (isMounted) {
          setVerified(false);
          setLoading(false);
        }
      }
    }

    checkStatus();
    return () => {
      isMounted = false;
    };
  }, [wallet, claim]);

  const isDark = theme === "dark" || (theme === "auto" && prefersDark);

  const bgColor = isDark ? "#0d1117" : "#f8fafc";
  const textColor = isDark ? "#f1f5f9" : "#0f172a";
  const borderColor = isDark ? "#30363d" : "#e2e8f0";
  const faintColor = isDark ? "#8b949e" : "#64748b";

  const claimLabels: Record<string, string> = {
    kyc: "KYC",
    age: "Age 18+",
    funds: "Funds",
    income: "Income",
    jurisdiction: "Jurisdiction",
    accreditation: "Accredited",
    employment: "Employment",
  };

  const claimText = claimLabels[claim.toLowerCase()] || claim.toUpperCase();

  return (
    <div
      style={{
        margin: 0,
        padding: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        background: "transparent",
        overflow: "hidden",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <a
        href="https://stellarcred.xyz"
        target="_blank"
        rel="noopener noreferrer"
        title={
          loading
            ? "Verifying StellarCred claim on-chain..."
            : verified
              ? `StellarCred: ${claimText} Verified for ${wallet}`
              : `StellarCred: ${claimText} Not Verified`
        }
        style={{
          textDecoration: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: isCompact ? "0.45rem" : "0.6rem",
          minWidth: 0,
          maxWidth: "100%",
          padding: isCompact ? "0.3rem 0.55rem" : "0.45rem 0.75rem",
          background: bgColor,
          color: textColor,
          border: `1px solid ${borderColor}`,
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          transition: "border-color 0.15s ease",
          fontSize: isCompact ? "0.75rem" : "0.82rem",
          userSelect: "none",
          cursor: "pointer",
          boxSizing: "border-box",
        }}
      >
        <img
          src={isDark ? "/brand/mark-dark.svg" : "/brand/mark-light.svg"}
          alt=""
          width={isCompact ? 14 : 16}
          height={isCompact ? 14 : 16}
          style={{ flexShrink: 0 }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: isCompact ? "18px" : "22px",
            height: isCompact ? "18px" : "22px",
            borderRadius: "50%",
            background: loading
              ? "rgba(148, 163, 184, 0.15)"
              : verified
                ? "rgba(16, 185, 129, 0.15)"
                : "rgba(239, 68, 68, 0.15)",
            color: loading
              ? faintColor
              : verified
                ? "#10b981"
                : "#ef4444",
            flexShrink: 0,
          }}
        >
          {loading ? (
            <IconLoader2 size={isCompact ? 12 : 14} className="animate-spin" />
          ) : verified ? (
            <IconCheck size={isCompact ? 12 : 14} stroke={2.5} />
          ) : (
            <IconX size={isCompact ? 12 : 14} stroke={2.5} />
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2, minWidth: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", minWidth: 0, overflow: "hidden" }}>
            <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              StellarCred
            </span>
            <span style={{ color: faintColor, flexShrink: 0 }}>·</span>
            <span
              style={{
                fontWeight: 500,
                color: faintColor,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {claimText}
            </span>
          </div>

          {!isCompact && (
            <div
              style={{
                fontSize: "0.68rem",
                color: faintColor,
                marginTop: "0.1rem",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {loading ? (
                "Checking on-chain..."
              ) : verified ? (
                <span style={{ color: "#10b981", fontWeight: 500 }}>
                  Verified {wallet ? `(${truncateHash(wallet)})` : ""}
                </span>
              ) : (
                <span style={{ color: "#ef4444" }}>Not verified</span>
              )}
            </div>
          )}
        </div>
      </a>
    </div>
  );
}

export default function BadgePage() {
  return (
    <div id="stellarcred-embed-root" style={{ width: "100%", height: "100%" }}>
      <Suspense
        fallback={
          <div style={{ padding: "0.5rem", fontSize: "0.75rem", color: "#888" }}>
            Loading verification badge...
          </div>
        }
      >
        <BadgeContent />
      </Suspense>
    </div>
  );
}
