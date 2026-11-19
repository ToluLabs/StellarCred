"use client";

/**
 * Search and filter component for credential inventory.
 *
 * Provides:
 * - Text search by credential name/type
 * - Filter facets (credential type, proof status)
 * - Sorting controls (date, type, expiry)
 * - Persistent query state via URL and localStorage
 *
 * Issue #902: Improve search and filtering for credential inventory
 */

import { useState, useEffect, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { IconSearch, IconX, IconChevronDown, IconSortAscending, IconSortDescending } from "@tabler/icons-react";
import type { Credential } from "@/lib/credential";
import { proofStatus, isExpiringSoon, daysRemaining } from "@/lib/proof-helpers";

export type CredentialType = "kyc" | "age" | "income" | "jurisdiction" | "funds";
export type ProofStatus = "unproved" | "proved" | "expired";

export interface SearchFilterState {
  query: string;
  types: CredentialType[];
  statuses: ProofStatus[];
  sortBy: "date-asc" | "date-desc" | "type-asc" | "type-desc" | "expiry-asc" | "expiry-desc";
}

export interface CredentialSearchFilterProps {
  credentials: Credential[];
  onFilteredChange: (filtered: Credential[]) => void;
}

const CREDENTIAL_TYPE_LABELS: Record<CredentialType, string> = {
  kyc: "KYC",
  age: "Age",
  income: "Income",
  jurisdiction: "Jurisdiction",
  funds: "Funds",
};

const STATUS_LABELS: Record<ProofStatus, string> = {
  unproved: "Ready to prove",
  proved: "Proved",
  expired: "Expired",
};

const SORT_LABELS: Record<SearchFilterState["sortBy"], string> = {
  "date-asc": "Issued (oldest first)",
  "date-desc": "Issued (newest first)",
  "type-asc": "Type (A-Z)",
  "type-desc": "Type (Z-A)",
  "expiry-asc": "Expiry (soonest first)",
  "expiry-desc": "Expiry (latest first)",
};

const STORAGE_KEY = "stellarcred:search-filter-state";

function loadPersistedState(): Partial<SearchFilterState> {
  if (typeof window === "undefined") return {};
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore localStorage errors
  }
  return {};
}

function savePersistedState(state: SearchFilterState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore localStorage errors
  }
}

export function CredentialSearchFilter({ credentials, onFilteredChange }: CredentialSearchFilterProps) {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Initialize state from URL params, then localStorage, then defaults
  const [state, setState] = useState<SearchFilterState>(() => {
    const urlQuery = searchParams.get("q") || "";
    const urlTypes = searchParams.get("types")?.split(",") as CredentialType[] || [];
    const urlStatuses = searchParams.get("statuses")?.split(",") as ProofStatus[] || [];
    const urlSort = (searchParams.get("sort") as SearchFilterState["sortBy"]) || "date-desc";

    const persisted = loadPersistedState();

    return {
      query: urlQuery || persisted.query || "",
      types: urlTypes.length > 0 ? urlTypes : persisted.types || [],
      statuses: urlStatuses.length > 0 ? urlStatuses : persisted.statuses || [],
      sortBy: urlSort || persisted.sortBy || "date-desc",
    };
  });

  const [showFilters, setShowFilters] = useState(false);
  const [showSort, setShowSort] = useState(false);

  // Sync state to URL and localStorage
  useEffect(() => {
    const params = new URLSearchParams();

    if (state.query) params.set("q", state.query);
    if (state.types.length > 0) params.set("types", state.types.join(","));
    if (state.statuses.length > 0) params.set("statuses", state.statuses.join(","));
    if (state.sortBy !== "date-desc") params.set("sort", state.sortBy);

    const newUrl = `/holder${params.toString() ? `?${params.toString()}` : ""}`;
    router.replace(newUrl, { scroll: false });

    savePersistedState(state);
  }, [state, router]);

  // Filter and sort credentials
  const filteredCredentials = useMemo(() => {
    let filtered = [...credentials];

    // Apply text search
    if (state.query) {
      const query = state.query.toLowerCase();
      filtered = filtered.filter((c) => {
        const title = c.title?.toLowerCase() || "";
        const type = c.type?.toLowerCase() || "";
        return title.includes(query) || type.includes(query);
      });
    }

    // Apply type filter
    if (state.types.length > 0) {
      filtered = filtered.filter((c) => state.types.includes(c.type as CredentialType));
    }

    // Apply status filter
    if (state.statuses.length > 0) {
      filtered = filtered.filter((c) => {
        const status = proofStatus(c);
        return state.statuses.includes(status);
      });
    }

    // Apply sorting
    filtered.sort((a, b) => {
      switch (state.sortBy) {
        case "date-asc":
          return (a.issuedAt || 0) - (b.issuedAt || 0);
        case "date-desc":
          return (b.issuedAt || 0) - (a.issuedAt || 0);
        case "type-asc":
          return a.type.localeCompare(b.type);
        case "type-desc":
          return b.type.localeCompare(a.type);
        case "expiry-asc":
          return daysRemaining(a) - daysRemaining(b);
        case "expiry-desc":
          return daysRemaining(b) - daysRemaining(a);
        default:
          return 0;
      }
    });

    return filtered;
  }, [credentials, state]);

  // Notify parent of filtered results
  useEffect(() => {
    onFilteredChange(filteredCredentials);
  }, [filteredCredentials, onFilteredChange]);

  const availableTypes = useMemo(() => {
    const types = new Set<CredentialType>();
    credentials.forEach((c) => {
      if (c.type) types.add(c.type as CredentialType);
    });
    return Array.from(types).sort();
  }, [credentials]);

  const toggleType = (type: CredentialType) => {
    setState((prev) => ({
      ...prev,
      types: prev.types.includes(type)
        ? prev.types.filter((t) => t !== type)
        : [...prev.types, type],
    }));
  };

  const toggleStatus = (status: ProofStatus) => {
    setState((prev) => ({
      ...prev,
      statuses: prev.statuses.includes(status)
        ? prev.statuses.filter((s) => s !== status)
        : [...prev.statuses, status],
    }));
  };

  const clearFilters = () => {
    setState((prev) => ({
      ...prev,
      query: "",
      types: [],
      statuses: [],
    }));
  };

  const hasActiveFilters = state.query || state.types.length > 0 || state.statuses.length > 0;

  return (
    <div className="card" style={{ padding: "1rem", marginBottom: "1.5rem" }}>
      {/* Search bar */}
      <div className="row" style={{ gap: "0.75rem", marginBottom: "0.75rem" }}>
        <div style={{ position: "relative", flex: 1 }}>
          <IconSearch
            size={16}
            style={{
              position: "absolute",
              left: "0.75rem",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--faint)",
            }}
          />
          <input
            type="text"
            placeholder="Search credentials by name or type..."
            value={state.query}
            onChange={(e) => setState((prev) => ({ ...prev, query: e.target.value }))}
            style={{
              width: "100%",
              padding: "0.6rem 0.75rem 0.6rem 2.25rem",
              fontSize: "0.875rem",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              background: "var(--bg)",
              color: "var(--text)",
            }}
          />
          {state.query && (
            <button
              type="button"
              onClick={() => setState((prev) => ({ ...prev, query: "" }))}
              style={{
                position: "absolute",
                right: "0.5rem",
                top: "50%",
                transform: "translateY(-50%)",
                background: "none",
                border: "none",
                color: "var(--faint)",
                cursor: "pointer",
                padding: "0.25rem",
              }}
              aria-label="Clear search"
            >
              <IconX size={14} />
            </button>
          )}
        </div>

        {/* Filter button */}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setShowFilters(!showFilters)}
          style={{
            position: "relative",
            ...(state.types.length > 0 || state.statuses.length > 0
              ? { borderColor: "var(--accent)", color: "var(--accent)" }
              : {}),
          }}
        >
          Filters
          {(state.types.length > 0 || state.statuses.length > 0) && (
            <span
              style={{
                marginLeft: "0.4rem",
                background: "var(--accent)",
                color: "var(--bg)",
                fontSize: "0.7rem",
                padding: "0.1rem 0.4rem",
                borderRadius: "10px",
                fontWeight: 600,
              }}
            >
              {state.types.length + state.statuses.length}
            </span>
          )}
          <IconChevronDown size={14} style={{ marginLeft: "0.3rem" }} />
        </button>

        {/* Sort button */}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setShowSort(!showSort)}
        >
          {state.sortBy === "date-desc" ? (
            <IconSortDescending size={14} style={{ marginRight: "0.3rem" }} />
          ) : (
            <IconSortAscending size={14} style={{ marginRight: "0.3rem" }} />
          )}
          Sort
        </button>

        {hasActiveFilters && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={clearFilters}
            style={{ fontSize: "0.8125rem" }}
          >
            Clear all
          </button>
        )}
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div
          style={{
            paddingTop: "0.75rem",
            borderTop: "1px solid var(--border)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "1rem",
          }}
        >
          {/* Type filters */}
          <div>
            <div style={{ fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.5rem" }}>
              Credential Type
            </div>
            <div className="stack" style={{ gap: "0.35rem" }}>
              {availableTypes.map((type) => (
                <label
                  key={type}
                  className="row"
                  style={{ gap: "0.5rem", fontSize: "0.875rem", cursor: "pointer", alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={state.types.includes(type)}
                    onChange={() => toggleType(type)}
                    style={{ cursor: "pointer" }}
                  />
                  {CREDENTIAL_TYPE_LABELS[type] || type}
                </label>
              ))}
            </div>
          </div>

          {/* Status filters */}
          <div>
            <div style={{ fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.5rem" }}>
              Proof Status
            </div>
            <div className="stack" style={{ gap: "0.35rem" }}>
              {(Object.keys(STATUS_LABELS) as ProofStatus[]).map((status) => (
                <label
                  key={status}
                  className="row"
                  style={{ gap: "0.5rem", fontSize: "0.875rem", cursor: "pointer", alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={state.statuses.includes(status)}
                    onChange={() => toggleStatus(status)}
                    style={{ cursor: "pointer" }}
                  />
                  {STATUS_LABELS[status]}
                </label>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Sort panel */}
      {showSort && (
        <div
          style={{
            paddingTop: "0.75rem",
            borderTop: "1px solid var(--border)",
          }}
        >
          <div style={{ fontSize: "0.8125rem", fontWeight: 600, marginBottom: "0.5rem" }}>
            Sort by
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "0.5rem",
            }}
          >
            {(Object.keys(SORT_LABELS) as SearchFilterState["sortBy"][]).map((sortOption) => (
              <button
                key={sortOption}
                type="button"
                className={`btn btn-sm ${state.sortBy === sortOption ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setState((prev) => ({ ...prev, sortBy: sortOption }))}
                style={{
                  justifyContent: "flex-start",
                  fontSize: "0.875rem",
                }}
              >
                {sortOption.includes("asc") ? (
                  <IconSortAscending size={14} style={{ marginRight: "0.4rem" }} />
                ) : (
                  <IconSortDescending size={14} style={{ marginRight: "0.4rem" }} />
                )}
                {SORT_LABELS[sortOption]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Results count */}
      {hasActiveFilters && (
        <div
          style={{
            marginTop: "0.75rem",
            paddingTop: "0.5rem",
            borderTop: "1px solid var(--border)",
            fontSize: "0.8125rem",
            color: "var(--faint)",
          }}
        >
          Showing {filteredCredentials.length} of {credentials.length} credentials
        </div>
      )}
    </div>
  );
}
