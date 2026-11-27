"use client";

import { IconSearch, IconX } from "@tabler/icons-react";

export interface CredentialSearchBarProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onChange: (value: string) => void;
  hasResults: boolean;
}

/**
 * Search/filter bar for the holder credential list, focusable via `/`.
 */
export function CredentialSearchBar({
  inputRef,
  query,
  onChange,
  hasResults,
}: CredentialSearchBarProps) {
  return (
    <>
      <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1 }}>
          <IconSearch
            size={15}
            aria-hidden="true"
            style={{
              position: "absolute",
              left: "0.75rem",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--faint)",
              pointerEvents: "none",
            }}
          />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (query) {
                  onChange("");
                } else {
                  inputRef.current?.blur();
                }
              }
            }}
            placeholder="Filter credentials by title, claim, issuer, or commitment…"
            aria-label="Filter credentials"
            style={{
              width: "100%",
              paddingLeft: "2.25rem",
              paddingRight: query ? "2.25rem" : "2rem",
            }}
          />
          {query ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onChange("")}
              aria-label="Clear filter"
              style={{
                position: "absolute",
                right: "0.35rem",
                top: "50%",
                transform: "translateY(-50%)",
                padding: "0.2rem",
              }}
            >
              <IconX size={14} aria-hidden="true" />
            </button>
          ) : (
            <kbd
              className="kbd"
              aria-hidden="true"
              style={{
                position: "absolute",
                right: "0.6rem",
                top: "50%",
                transform: "translateY(-50%)",
                pointerEvents: "none",
              }}
            >
              /
            </kbd>
          )}
        </div>
      </div>

      {!hasResults && (
        <p className="faint" role="status" style={{ fontSize: "0.875rem" }}>
          No credentials match &ldquo;{query}&rdquo;.
        </p>
      )}
    </>
  );
}
