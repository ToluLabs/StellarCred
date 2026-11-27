"use client";

import { useId, useState } from "react";
import { IconExternalLink, IconTrash, IconHistory, IconInfoCircle } from "@tabler/icons-react";
import { Badge } from "@/components/Badge";
import { IssuerAvatar } from "@/components/IssuerAvatar";
import { Timeline } from "@/components/Timeline";
import { truncateHash } from "@/lib/format";
import { pubkeyHexFromParts } from "@/lib/issuer-avatar";
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
import { CredTimelineSkeleton } from "@/components/holder/CredListSkeleton";

export interface BatchSelection {
  checked: boolean;
  /** Why this card cannot be added to the batch, or null when it can. */
  blockedReason: string | null;
  onToggle: () => void;
}

export function CredCard({
  c,
  address,
  onProve,
  onRemove,
  onInspect,
  isPreview,
  selection,
  isActive = false,
  cardRef,
}: {
  c: Credential;
  address: string;
  onProve: () => void;
  onRemove: () => void;
  onInspect?: () => void;
  isPreview?: boolean;
  /** When present, renders a batch-selection checkbox. Omit for non-batchable cards. */
  selection?: BatchSelection;
  /** Whether this card is currently highlighted by keyboard navigation. */
  isActive?: boolean;
  /** Optional ref callback for scrolling the active card into view. */
  cardRef?: (el: HTMLElement | null) => void;
}) {
  const status = proofStatus(c);
  const { events, loading: historyLoading } = useProofTimeline(c);
  const [showHistory, setShowHistory] = useState(false);
  const uid = useId();
  const titleId = `${uid}-title`;
  const historyId = `${uid}-history`;

  return (
    <article
      ref={cardRef}
      className={`card cred-card${isActive ? " cred-card--active" : ""}`}
      aria-labelledby={titleId}
      aria-current={isActive ? "true" : undefined}
      data-active={isActive ? "true" : undefined}
    >
      <div className="cred-card__top">
        {/* left: credential info */}
        <div className="cred-card__info">
          <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
            <h3 id={titleId} className="cred-card__title">
              {c.title}
            </h3>
            <span className="mono faint" style={{ fontSize: "0.7rem" }}>
              {c.claim}
            </span>
          </div>
          <div className="cred-card__meta">
            <div>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  verticalAlign: "middle",
                }}
              >
                <IssuerAvatar
                  publicKey={pubkeyHexFromParts(c.issuerPubX, c.issuerPubY)}
                  name={c.issuer}
                  size={22}
                />
                {c.issuer}
              </span>{" "}
              &middot; <span>{truncateHash(c.commitment)}</span>
              {status === "proved" && (
                <>
                  {" "}
                  <span className="cred-card__expires">expires in {daysRemaining(c)}d</span>
                  {c.provedTxHash && (
                    <>
                      {" "}
                      <a
                        href={EXPLORER_TX(c.provedTxHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="cred-card__tx-link"
                        aria-label={`View proof transaction ${c.provedTxHash.slice(0, 6)} on Stellar Expert (opens in a new tab)`}
                      >
                        {c.provedTxHash.slice(0, 6)}&hellip;
                        <IconExternalLink size={10} aria-hidden="true" />
                      </a>
                    </>
                  )}
                </>
              )}
              {status === "expired" && (
                <>
                  {" "}
                  <span className="cred-card__expired">expired</span>
                </>
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
          {selection && (
            <input
              type="checkbox"
              checked={selection.checked}
              disabled={!selection.checked && selection.blockedReason !== null}
              title={selection.blockedReason ?? undefined}
              onChange={selection.onToggle}
              aria-label={`Select ${c.title} for batch`}
              style={{
                cursor: selection.blockedReason && !selection.checked ? "not-allowed" : "pointer",
              }}
            />
          )}
          {isPreview && <Badge variant="pending">Preview</Badge>}
          <Badge variant="verified" dot={false}>
            Held
          </Badge>
          {status === "proved" && !isExpiringSoon(c) && (
            <Badge variant="verified" dot={false}>
              On-chain
            </Badge>
          )}
          {status === "proved" && isExpiringSoon(c) && (
            <Badge variant="pending" dot={true}>
              Expiring in {daysRemaining(c)}d
            </Badge>
          )}
          {status === "expired" && (
            <Badge variant="denied" dot={true}>
              Proof Expired
            </Badge>
          )}
          {onInspect && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="View details"
              aria-label={`View details for ${c.title}`}
              onClick={onInspect}
            >
              <IconInfoCircle size={13} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
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
            {status === "proved"
              ? "Re-prove"
              : status === "expired"
                ? "Re-prove"
                : "Generate proof"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="History"
            aria-label={`${showHistory ? "Hide" : "Show"} proof history for ${c.title}`}
            aria-expanded={showHistory}
            aria-controls={historyId}
            onClick={() => setShowHistory(!showHistory)}
          >
            <IconHistory size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="Remove"
            aria-label={`Remove ${c.title}`}
            onClick={onRemove}
          >
            <IconTrash size={13} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div id={historyId} hidden={!showHistory}>
        {showHistory && (historyLoading ? <CredTimelineSkeleton /> : <Timeline events={events} />)}
      </div>
    </article>
  );
}
