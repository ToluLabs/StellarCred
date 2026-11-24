"use client";

/**
 * Loading placeholders for credential-heavy screens.
 *
 * Credentials hydrate from (encrypted) localStorage after mount, so the holder
 * dashboard would otherwise render an empty state — then swap in the real list,
 * shifting everything below it. These skeletons reserve the height of a real
 * card so the transition does not move surrounding content.
 *
 * Accessibility: every placeholder shape is decorative and `aria-hidden`, so
 * no focusable tab stops are added while loading. The wrapper is a single
 * `role="status"` live region with a visually hidden message, so screen-reader
 * users hear "Loading credentials…" exactly once.
 */

export function CredCardSkeleton() {
  return (
    <div className="card cred-card skeleton-card" aria-hidden="true">
      <div className="cred-card__top">
        <div className="cred-card__info">
          <div className="skeleton skeleton-line skeleton-line--title" />
          <div className="skeleton skeleton-line skeleton-line--meta" />
          <div className="skeleton skeleton-line skeleton-line--meta-sm" />
        </div>
        <div className="card-actions">
          <div className="skeleton skeleton-pill" />
          <div className="skeleton skeleton-btn" />
        </div>
      </div>
    </div>
  );
}

export function CredListSkeleton({
  rows = 3,
  label = "Loading credentials…",
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div className="stack" style={{ gap: "0.6rem" }} aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <CredCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

/** Reserved-height placeholder for a credential's proof-history timeline. */
export function CredTimelineSkeleton({
  rows = 3,
  label = "Loading proof history…",
}: {
  rows?: number;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className="timeline-skeleton"
    >
      <span className="sr-only">{label}</span>
      <div className="stack" style={{ gap: "0.25rem" }} aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="timeline-skeleton__row">
            <div className="skeleton timeline-skeleton__dot" />
            <div className="skeleton timeline-skeleton__bar" />
          </div>
        ))}
      </div>
    </div>
  );
}
