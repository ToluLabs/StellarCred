"use client";

import { useMemo } from "react";
import { IconCheck, IconExternalLink, IconAlertTriangle, IconCertificate, IconCpu, IconCloudUpload, IconShieldCheck } from "@tabler/icons-react";
import { EXPLORER_TX } from "@/lib/stellar";
import type { TimelineEvent } from "@/lib/useProofTimeline";

interface TimelineProps {
  events: TimelineEvent[];
}

export function Timeline({ events }: TimelineProps) {
  // Map event stages to friendly titles and icons
  const stageInfo = useMemo(() => {
    return {
      issued: { title: "Credential Issued", icon: <IconCertificate size={14} />, color: "var(--accent)" },
      generated: { title: "Proof Generated", icon: <IconCpu size={14} />, color: "var(--accent)" },
      preflight: { title: "Preflight Simulation Passed", icon: <IconShieldCheck size={14} />, color: "var(--accent)" },
      submitted: { title: "Proof Submitted", icon: <IconCloudUpload size={14} />, color: "var(--accent)" },
      verified: { title: "On-chain Verified", icon: <IconCheck size={14} />, color: "var(--accent)" },
      expired: { title: "Credential Expired", icon: <IconAlertTriangle size={14} />, color: "var(--danger)" },
    };
  }, []);

  if (!events || events.length === 0) return null;

  return (
    <div className="timeline-container" style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px dashed var(--border)" }}>
      <span className="eyebrow" style={{ marginBottom: "1rem", display: "block" }}>Proof History</span>
      
      <div className="timeline-steps" style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        {events.map((event, index) => {
          const info = stageInfo[event.stage];
          if (!info) return null;
          
          const isLast = index === events.length - 1;
          const isExpired = event.stage === "expired";
          const date = new Date(event.timestamp * 1000).toLocaleString(undefined, {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
          });

          return (
            <div key={`${event.stage}-${event.timestamp}`} style={{ display: "flex", gap: "1rem" }}>
              {/* Left column: Connector & Icon */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div 
                  className="timeline-icon" 
                  style={{ 
                    width: 26, 
                    height: 26, 
                    borderRadius: "50%", 
                    display: "flex", 
                    alignItems: "center", 
                    justifyContent: "center",
                    background: isExpired ? "rgba(240, 96, 77, 0.15)" : "rgba(62, 207, 142, 0.15)",
                    color: info.color,
                    border: `1px solid ${isExpired ? "rgba(240, 96, 77, 0.3)" : "rgba(62, 207, 142, 0.3)"}`
                  }}
                >
                  {info.icon}
                </div>
                {!isLast && (
                  <div 
                    style={{ 
                      width: 1, 
                      flexGrow: 1, 
                      background: isExpired ? "rgba(240, 96, 77, 0.3)" : "var(--border)", 
                      margin: "4px 0" 
                    }} 
                  />
                )}
              </div>

              {/* Right column: Content */}
              <div style={{ paddingBottom: isLast ? 0 : "1.25rem", display: "flex", flexDirection: "column", justifyContent: "flex-start", paddingTop: "0.2rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span style={{ fontSize: "0.85rem", fontWeight: 500, color: isExpired ? "var(--danger)" : "var(--text)" }}>
                    {info.title}
                  </span>
                  <span className="mono faint" style={{ fontSize: "0.7rem" }}>
                    {date}
                  </span>
                </div>
                
                {event.txHash && (
                  <a
                    href={EXPLORER_TX(event.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="mono accent"
                    style={{ 
                      display: "inline-flex", 
                      alignItems: "center", 
                      gap: "0.25rem", 
                      fontSize: "0.75rem",
                      marginTop: "0.35rem",
                      opacity: 0.85,
                      textDecoration: "underline",
                      textUnderlineOffset: "2px",
                    }}
                  >
                    {event.txHash.slice(0, 8)}...{event.txHash.slice(-6)}
                    <IconExternalLink size={11} />
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
