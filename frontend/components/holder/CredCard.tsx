"use client";

import { useState } from "react";
import {
  IconExternalLink,
  IconTrash,
  IconHistory,
  IconInfoCircle,
} from "@tabler/icons-react";
import { Badge } from "@/components/Badge";
import { Timeline } from "@/components/Timeline";
import { truncateHash } from "@/lib/format";
import { EXPLORER_TX } from "@/lib/stellar";
import { proofSubmissionConfigured } from "@/lib/config";
import { useProofTimeline } from "@/lib/useProofTimeline";
import {
  proofStatus,
  isExpiringSoon,
  daysRemaining,
  credIsExpired,
  credExpiryTimestamp,
  credExpiryWithinDays,
  formatExpiryDate,
} from "@/lib/proof-helpers";
import type { Credential } from "@/lib/credential";

export function CredCard({
  c,
  address,
  onProve,
  onRemove,
  onInspect,
  isPreview,
}: {
  c: Credential;
  address: string;
  onProve: () => void;
  onRemove: () => void;
  onInspect?: () => void;
  isPreview?: boolean;
}) {
  const status = proofStatus(c);
  const { events } = useProofTimeline(c);
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div className="card cred-card">
      <div className="cred-card__top">
        {/* left: credential info */}
        <div className="cred-card__info">
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <span className="cred-card__title">{c.title}</span>
            <span className="mono faint" style={{ fontSize: "0.7rem" }}>{c.claim}</span>
          </div>
          <div className="cred-card__meta">
            <div>
              {c.issuer} &middot; <span>{truncateHash(c.commitment)}</span>
              {status === "proved" && (
                <>
                  {" "}
                  <span className="cred-card__expires">
                    expires in {daysRemaining(c)}d
                  </span>
                  {c.provedTxHash && (
                    <>
                      {" "}
                      <a
                        href={EXPLORER_TX(c.provedTxHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="cred-card__tx-link"
                      >
                        {c.provedTxHash.slice(0, 6)}&hellip;<IconExternalLink size={10} />
                      </a>
                    </>
                  )}
                </>
              )}
              {status === "expired" && (
                <> <span className="cred-card__expired">expired</span></>
              )}
            </div>
            <div className="cred-card__expiry">
              {credIsExpired(c) ? (
                <span className="cred-card__expired-label">Expired</span>
              ) : (
                <span className={credExpiryWithinDays(c, 30) ? "cred-card__expiring" : "faint"}>
                  Expires {formatExpiryDate(credExpiryTimestamp(c))}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* right: badges + buttons */}
        <div className="card-actions">
          {isPreview && <Badge variant="pending">Preview</Badge>}
          <Badge variant="verified" dot={false}>Held</Badge>
          {status === "proved" && !isExpiringSoon(c) && (
            <Badge variant="verified" dot={false}>On-chain</Badge>
          )}
          {status === "proved" && isExpiringSoon(c) && (
            <Badge variant="pending" dot={true}>Expiring in {daysRemaining(c)}d</Badge>
          )}
          {status === "expired" && (
            <Badge variant="denied" dot={true}>Proof Expired</Badge>
          )}
          {onInspect && (
            <button
              className="btn btn-ghost btn-sm"
              title="View details"
              onClick={onInspect}
            >
              <IconInfoCircle size={13} />
            </button>
          )}
          <button
            className={`btn btn-sm ${status === "proved" ? "btn-secondary" : "btn-primary"}`}
            disabled={!address || credIsExpired(c) || !proofSubmissionConfigured()}
            title={
              !address
                ? "Connect a wallet first"
                : credIsExpired(c)
                  ? "This credential has expired"
                  : !proofSubmissionConfigured()
                    ? "App not configured — NEXT_PUBLIC_PROOF_REGISTRY_ID missing"
                    : undefined
            }
            onClick={onProve}
          >
            {status === "proved" ? "Re-prove" :
             status === "expired" ? "Re-prove" :
                                    "Generate proof"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="History"
            onClick={() => setShowHistory(!showHistory)}
          >
            <IconHistory size={13} />
          </button>
          <button
            className="btn btn-ghost btn-sm"
            title="Remove"
            onClick={onRemove}
          >
            <IconTrash size={13} />
          </button>
        </div>
      </div>

      {showHistory && (
        <Timeline events={events} />
      )}
    </div>
  );
}
