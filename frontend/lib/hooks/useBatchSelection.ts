"use client";

/**
 * useBatchSelection — manages batch selection state for the holder page.
 *
 * Enforces on-chain limits before anything is proved:
 *   - At most MAX_BATCH_SIZE entries
 *   - No two entries of the same credential type (the registry keeps one slot
 *     per (holder, credential_type))
 *
 * Cleans up stale selections automatically when the unproved list changes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { type Credential } from "../credential";
import { MAX_BATCH_SIZE } from "../contracts";

export function useBatchSelection(
  unproved: Credential[],
  address: string,
  onError: (message: string) => void,
) {
  const [selectedCommitments, setSelectedCommitments] = useState<string[]>([]);

  // Derived data — memoized so consumers can reference without re-render loops.
  const selectedCreds = useMemo(
    () => unproved.filter((c) => selectedCommitments.includes(c.commitment)),
    [unproved, selectedCommitments],
  );

  const selectedTypes = useMemo(
    () => new Set(selectedCreds.map((c) => c.type)),
    [selectedCreds],
  );

  const atBatchLimit = selectedCreds.length >= MAX_BATCH_SIZE;

  // ── Stale selection cleanup ────────────────────────────────────────────────
  // Drop selections for credentials that are no longer selectable (removed,
  // transferred, or just proved). Keys on commitments to avoid unnecessary state
  // updates.
  const unprovedKey = unproved.map((c) => c.commitment).join(",");
  useEffect(() => {
    if (!unprovedKey) {
      setSelectedCommitments((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const live = new Set(unprovedKey.split(","));
    setSelectedCommitments((prev) => {
      const next = prev.filter((h) => live.has(h));
      return next.length === prev.length ? prev : next;
    });
  }, [unprovedKey]);

  // ── Selection logic ────────────────────────────────────────────────────────

  /** Why `c` cannot be added to the current selection, or null if it can. */
  const blockedReason = useCallback(
    (c: Credential): string | null => {
      if (selectedCommitments.includes(c.commitment)) return null;
      if (selectedTypes.has(c.type)) {
        return `A batch can hold only one ${c.type} credential — the registry keeps one proof per credential type.`;
      }
      if (atBatchLimit) {
        return `A batch holds at most ${MAX_BATCH_SIZE} credentials. Deselect one to swap it out.`;
      }
      return null;
    },
    [selectedCommitments, selectedTypes, atBatchLimit],
  );

  const toggleSelected = useCallback(
    (c: Credential) => {
      if (selectedCommitments.includes(c.commitment)) {
        setSelectedCommitments((prev) => prev.filter((h) => h !== c.commitment));
        return;
      }
      const blocked = blockedReason(c);
      if (blocked) {
        onError(blocked);
        return;
      }
      setSelectedCommitments((prev) => [...prev, c.commitment]);
    },
    [selectedCommitments, blockedReason, onError],
  );

  /** Fill the selection with the first eligible credential of each type. */
  const selectEligible = useCallback(() => {
    const picked: string[] = [];
    const types = new Set<string>();
    for (const c of unproved) {
      if (picked.length >= MAX_BATCH_SIZE) break;
      if (types.has(c.type)) continue;
      types.add(c.type);
      picked.push(c.commitment);
    }
    setSelectedCommitments(picked);
  }, [unproved]);

  const clearSelection = useCallback(() => {
    setSelectedCommitments([]);
  }, []);

  // ── Capability flags ───────────────────────────────────────────────────────
  // Selecting is only offered when a batch is actually possible: a connected
  // wallet and at least two credentials of distinct types.
  const distinctUnprovedTypes = new Set(unproved.map((c) => c.type)).size;
  const canBatch = Boolean(address) && distinctUnprovedTypes >= 2;
  const canSubmitBatch = selectedCreds.length >= 2;

  return {
    selectedCommitments,
    selectedCreds,
    selectedTypes,
    atBatchLimit,
    canBatch,
    canSubmitBatch,
    blockedReason,
    toggleSelected,
    selectEligible,
    clearSelection,
  };
}
