"use client";

import { useRef } from "react";
import { IconShieldCheck } from "@tabler/icons-react";
import { Badge } from "@/components/Badge";
import type { RegisteredIssuer } from "@/lib/issuer-registry";
import { isProtocolAccepted } from "@/lib/issuer-choice";
import { truncateAddress } from "@/lib/format";

export interface IssuerSelectorProps {
  issuersForType: RegisteredIssuer[];
  selectedIssuerId: string;
  setSelectedIssuerId: (id: string) => void;
  trustedIssuerGate?: string[];
  anyAccepted: boolean;
  requestingDomain?: string;
}

export function IssuerSelector({
  issuersForType,
  selectedIssuerId,
  setSelectedIssuerId,
  trustedIssuerGate,
  anyAccepted,
  requestingDomain,
}: IssuerSelectorProps) {
  const issuerRefs = useRef<Record<string, HTMLDivElement | null>>({});

  if (issuersForType.length === 0) return null;

  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <label className="field-label" id="issuer-choice-label">
        Issuing authority
      </label>
      <p
        className="faint"
        style={{ fontSize: "0.8125rem", margin: "0.35rem 0 0.6rem" }}
      >
        {issuersForType.length}{" "}
        {issuersForType.length === 1
          ? "registered issuer can"
          : "registered issuers can"}{" "}
        attest this claim.
        {trustedIssuerGate
          ? " Only the ones marked accepted satisfy this protocol."
          : " Pick which one issues to you."}
      </p>
      <div
        className="stack"
        role="radiogroup"
        aria-labelledby="issuer-choice-label"
        style={{ gap: "0.5rem" }}
      >
        {issuersForType.map((issuer, i) => {
          const on = issuer.id === selectedIssuerId;
          const accepted = isProtocolAccepted(issuer.id, trustedIssuerGate);
          const detail = [truncateAddress(issuer.id), issuer.metadata?.url]
            .filter(Boolean)
            .join(" · ");

          const focus = (index: number) => {
            const next =
              issuersForType[
                (index + issuersForType.length) % issuersForType.length
              ];
            setSelectedIssuerId(next.id);
            issuerRefs.current[next.id]?.focus();
          };

          return (
            <div
              key={issuer.id}
              ref={(el) => {
                issuerRefs.current[issuer.id] = el;
              }}
              role="radio"
              aria-checked={on}
              aria-label={
                accepted
                  ? issuer.name
                  : `${issuer.name} (not accepted by this protocol)`
              }
              tabIndex={on ? 0 : -1}
              onClick={() => setSelectedIssuerId(issuer.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedIssuerId(issuer.id);
                } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                  e.preventDefault();
                  focus(i + 1);
                } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  focus(i - 1);
                }
              }}
              style={{
                padding: "0.75rem 0.9rem",
                borderRadius: "var(--radius)",
                border: `1px solid ${
                  on ? "rgba(62,207,142,0.4)" : "var(--border)"
                }`,
                background: on ? "rgba(62,207,142,0.05)" : "transparent",
                cursor: "pointer",
                transition:
                  "border-color 0.2s var(--ease), background 0.2s var(--ease)",
              }}
            >
              <div
                className="between"
                style={{ alignItems: "center", gap: "0.75rem" }}
              >
                <span
                  className="row"
                  style={{ gap: "0.6rem", minWidth: 0 }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      display: "grid",
                      placeItems: "center",
                      border: `2px solid ${
                        on ? "var(--accent)" : "var(--border)"
                      }`,
                      flexShrink: 0,
                    }}
                  >
                    {on && (
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "var(--accent)",
                        }}
                      />
                    )}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontWeight: 500,
                        fontSize: "0.9rem",
                      }}
                    >
                      {issuer.name}
                    </span>
                    <span
                      className="mono faint"
                      style={{
                        display: "block",
                        fontSize: "0.72rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {detail}
                    </span>
                  </span>
                </span>
                {trustedIssuerGate &&
                  (accepted ? (
                    <Badge variant="verified" dot={false}>
                      <span
                        className="row"
                        style={{ gap: "0.3rem" }}
                      >
                        <IconShieldCheck size={13} />
                        Accepted by protocol
                      </span>
                    </Badge>
                  ) : (
                    <Badge variant="denied" dot={false}>
                      Not accepted
                    </Badge>
                  ))}
              </div>
            </div>
          );
        })}
      </div>
      {!anyAccepted && (
        <p
          style={{
            marginTop: "0.6rem",
            fontSize: "0.8125rem",
            color: "var(--danger)",
            lineHeight: 1.6,
          }}
        >
          None of the issuers registered for this claim is accepted by{" "}
          {requestingDomain || "this protocol"} — its gate will reject the proof
          whichever issuer you pick.
        </p>
      )}
    </div>
  );
}
