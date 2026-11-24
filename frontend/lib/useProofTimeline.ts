"use client";

import { useState, useEffect, useCallback } from "react";
import type { Credential } from "./credential";
import { isStorageAvailable } from "./safe-storage";

export type TimelineEventStage =
  | "issued"
  | "generated"
  | "preflight"
  | "submitted"
  | "verified"
  | "expired";

export interface TimelineEvent {
  stage: TimelineEventStage;
  timestamp: number;
  txHash?: string;
}

export interface TimelineData {
  events: TimelineEvent[];
}

const TIMELINE_PREFIX = "proofTimeline:";

export function useProofTimeline(cred: Credential | null) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);

  // Load from local storage
  const loadTimeline = useCallback((commitment: string) => {
    try {
      const stored = localStorage.getItem(`${TIMELINE_PREFIX}${commitment}`);
      if (stored) {
        return JSON.parse(stored) as TimelineData;
      }
    } catch {
      // ignore
    }
    return { events: [] };
  }, []);

  // Save to local storage
  const saveTimeline = useCallback((commitment: string, data: TimelineData) => {
    try {
      localStorage.setItem(`${TIMELINE_PREFIX}${commitment}`, JSON.stringify(data));
    } catch {
      // ignore
    }
  }, []);

  // Sync and reconcile on mount or cred change
  useEffect(() => {
    if (!cred) return;
    const { commitment } = cred;
    const data = loadTimeline(commitment);

    // Reconcile issuedAt
    if (cred.issuedAt && !data.events.some((e) => e.stage === "issued")) {
      data.events.push({ stage: "issued", timestamp: cred.issuedAt });
    }

    // Reconcile verification (provedAt)
    if (cred.provedAt && !data.events.some((e) => e.stage === "verified")) {
      data.events.push({ stage: "verified", timestamp: cred.provedAt, txHash: cred.provedTxHash });
    }

    // Check expiry
    // 30 days is the default as implemented in page.tsx
    const match = cred.expiry?.match(/(\d+)/);
    const ttlSecs = (match ? parseInt(match[1]) : 30) * 86_400;
    const isExpired = cred.provedAt ? cred.provedAt + ttlSecs <= Math.floor(Date.now() / 1000) : false;

    if (isExpired && !data.events.some((e) => e.stage === "expired")) {
      data.events.push({ stage: "expired", timestamp: cred.provedAt! + ttlSecs });
    } else if (!isExpired) {
      // Remove expired if somehow it's not expired anymore
      data.events = data.events.filter((e) => e.stage !== "expired");
    }

    // Sort events by timestamp
    data.events.sort((a, b) => a.timestamp - b.timestamp);

    saveTimeline(commitment, data);
    setEvents(data.events);
  }, [cred, loadTimeline, saveTimeline]);

  // Cross-tab sync: listen for storage events from other tabs
  useEffect(() => {
    if (!cred || !isStorageAvailable()) return;
    const { commitment } = cred;
    const timelineKey = `${TIMELINE_PREFIX}${commitment}`;

    // Debounced reload to avoid thrash on rapid writes
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const debouncedReload = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        const data = loadTimeline(commitment);
        setEvents(data.events);
      }, 100); // 100ms debounce
    };

    const handleStorage = (e: StorageEvent) => {
      // Only reload if this credential's timeline key changed
      if (e.key === timelineKey) {
        debouncedReload();
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [cred, loadTimeline]);

  // Hook to add a new event from the UI
  const addEvent = useCallback(
    (stage: TimelineEventStage, data?: { txHash?: string; timestamp?: number }) => {
      if (!cred) return;
      const { commitment } = cred;
      const timelineData = loadTimeline(commitment);
      
      const newEvent: TimelineEvent = {
        stage,
        timestamp: data?.timestamp || Math.floor(Date.now() / 1000),
        txHash: data?.txHash,
      };

      // Replace if stage already exists, otherwise add
      const existingIdx = timelineData.events.findIndex((e) => e.stage === stage);
      if (existingIdx >= 0) {
        timelineData.events[existingIdx] = newEvent;
      } else {
        timelineData.events.push(newEvent);
      }

      timelineData.events.sort((a, b) => a.timestamp - b.timestamp);
      saveTimeline(commitment, timelineData);
      setEvents(timelineData.events);
    },
    [cred, loadTimeline, saveTimeline]
  );

  return { events, addEvent };
}

// Helper to add events outside of React lifecycle (e.g. loops/batches)
export function addTimelineEvent(
  commitment: string,
  stage: TimelineEventStage,
  data?: { txHash?: string; timestamp?: number }
) {
  try {
    const stored = localStorage.getItem(`${TIMELINE_PREFIX}${commitment}`);
    const timelineData: TimelineData = stored ? JSON.parse(stored) : { events: [] };

    const newEvent: TimelineEvent = {
      stage,
      timestamp: data?.timestamp || Math.floor(Date.now() / 1000),
      txHash: data?.txHash,
    };

    const existingIdx = timelineData.events.findIndex((e) => e.stage === stage);
    if (existingIdx >= 0) {
      timelineData.events[existingIdx] = newEvent;
    } else {
      timelineData.events.push(newEvent);
    }

    timelineData.events.sort((a, b) => a.timestamp - b.timestamp);
    localStorage.setItem(`${TIMELINE_PREFIX}${commitment}`, JSON.stringify(timelineData));
  } catch {
    // ignore
  }
}
