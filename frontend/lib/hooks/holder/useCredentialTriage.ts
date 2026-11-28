"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Credential } from "@/lib/credential";
import { useBatchSelection } from "@/lib/hooks/useBatchSelection";
import { useCredentialBuckets, type CredentialBuckets } from "@/lib/hooks/useCredentialBuckets";
import { useKeyboardShortcuts } from "@/lib/hooks/useKeyboardShortcuts";
import { credIsExpired } from "@/lib/proof-helpers";
import { proofSubmissionConfigured } from "@/lib/config";

export interface UseCredentialTriageOptions {
  creds: Credential[];
  address: string;
  isEnabled: boolean;
  onBatchError: (msg: string) => void;
  onInspect: (cred: Credential) => void;
  onProve: (cred: Credential) => void;
  onExport: () => void;
  onOpenHelp: () => void;
}

export interface UseCredentialTriageResult extends CredentialBuckets {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  filteredCreds: Credential[];
  activeCommitment: string | null;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  setCardRef: (commitment: string, el: HTMLElement | null) => void;
  batch: ReturnType<typeof useBatchSelection>;
}

/**
 * Encapsulates credential search filtering, bucket ordering, batch selection,
 * active keyboard selection, scroll-into-view, and triage hotkeys for the holder page.
 */
export function useCredentialTriage({
  creds,
  address,
  isEnabled,
  onBatchError,
  onInspect,
  onProve,
  onExport,
  onOpenHelp,
}: UseCredentialTriageOptions): UseCredentialTriageResult {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());

  const filteredCreds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return creds;
    return creds.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.claim.toLowerCase().includes(q) ||
        c.issuer.toLowerCase().includes(q) ||
        c.commitment.toLowerCase().includes(q),
    );
  }, [creds, searchQuery]);

  const buckets = useCredentialBuckets(filteredCreds);
  const { unproved, expiringSoon, activeProved, expired } = buckets;
  const batch = useBatchSelection(unproved, address, onBatchError);

  const orderedCreds = useMemo(
    () => [...expiringSoon, ...expired, ...unproved, ...activeProved],
    [expiringSoon, expired, unproved, activeProved],
  );

  const clampedActiveIndex =
    orderedCreds.length === 0
      ? -1
      : activeIndex >= orderedCreds.length
        ? orderedCreds.length - 1
        : activeIndex;

  const activeCommitment =
    clampedActiveIndex >= 0 && clampedActiveIndex < orderedCreds.length
      ? orderedCreds[clampedActiveIndex].commitment
      : null;

  useEffect(() => {
    if (!activeCommitment) return;
    cardRefs.current.get(activeCommitment)?.scrollIntoView?.({ block: "nearest" });
  }, [activeCommitment]);

  useKeyboardShortcuts({
    enabled: isEnabled,
    itemCount: orderedCreds.length,
    activeIndex: clampedActiveIndex,
    setActiveIndex,
    onFocusSearch: () => searchInputRef.current?.focus(),
    onInspect: (idx) => {
      const target = orderedCreds[idx];
      if (target) onInspect(target);
    },
    onProve: (idx) => {
      const target = orderedCreds[idx];
      if (!target || !address || credIsExpired(target) || !proofSubmissionConfigured()) return;
      onProve(target);
    },
    onToggleSelect: (idx) => {
      const target = orderedCreds[idx];
      if (!target || !batch.canBatch) return;
      if (unproved.some((u) => u.commitment === target.commitment)) {
        batch.toggleSelected(target);
      }
    },
    onExport,
    onOpenHelp,
    onEscape: () => {
      if (clampedActiveIndex !== -1) {
        setActiveIndex(-1);
      } else if (searchQuery) {
        setSearchQuery("");
      }
    },
  });

  function setCardRef(commitment: string, el: HTMLElement | null) {
    if (el) {
      cardRefs.current.set(commitment, el);
    } else {
      cardRefs.current.delete(commitment);
    }
  }

  return {
    ...buckets,
    searchQuery,
    setSearchQuery,
    filteredCreds,
    activeCommitment,
    searchInputRef,
    setCardRef,
    batch,
  };
}
