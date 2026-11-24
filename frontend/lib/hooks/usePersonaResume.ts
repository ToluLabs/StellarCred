"use client";

import { useEffect, useRef, useState } from "react";
import type { Credential } from "@/lib/credential";
import {
  loadPersonaPending,
  clearStalePersonaPending,
} from "@/lib/persona-pending";
import { getOrCreateRequestId } from "@/lib/verify-session";
import { useToast } from "@/components/Toast";

export interface UsePersonaResumeOptions {
  personaInquiryId: string | null;
  address: string | null;
  onSuccess: (credentials: Credential[]) => Promise<void> | void;
  onError?: (error: string) => void;
  onBusyChange?: (busy: boolean) => void;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  fetchFn?: typeof fetch;
}

export function usePersonaResume({
  personaInquiryId,
  address,
  onSuccess,
  onError,
  onBusyChange,
  maxPollAttempts = 15,
  pollIntervalMs = 2000,
  fetchFn = typeof fetch !== "undefined" ? fetch : (async () => ({} as Response)),
}: UsePersonaResumeOptions) {
  const [isResuming, setIsResuming] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;

  // Guarantee cleanup on abandonment: if the user comes back from Persona
  // without an inquiry-id (cancelled mid-flow) — or never left — any lingering
  // sc_persona_pending blob is wiped on mount. loadPersonaPending() clears on
  // read for the success/failure paths below.
  useEffect(() => {
    clearStalePersonaPending(Boolean(personaInquiryId));
  }, [personaInquiryId]);

  // When Persona redirects back to /verify?inquiry-id=XXX, poll for async
  // issuance completion via /api/persona/result, falling back to /api/issue.
  useEffect(() => {
    if (!personaInquiryId || !address) return;

    // Read-and-clear: the blob is removed before the resumed call is made,
    // so it's gone whether the issue succeeds or fails.
    const pending = loadPersonaPending();
    setIsResuming(true);
    onBusyChangeRef.current?.(true);
    setError("");
    const requestId = getOrCreateRequestId();

    let cancelled = false;
    let pollTimeout: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const handleSuccess = async (credentials: Credential[]) => {
      await onSuccessRef.current(credentials);
      if (!cancelled) {
        setIsResuming(false);
        onBusyChangeRef.current?.(false);
      }
    };

    const handleError = (msg: string) => {
      if (cancelled) return;
      const formatted = `${msg} (ref: ${requestId})`;
      setError(formatted);
      onErrorRef.current?.(formatted);
      toast.error(`Credential issuance failed: ${msg}`);
      setIsResuming(false);
      onBusyChangeRef.current?.(false);
    };

    const pollResult = async () => {
      if (cancelled) return;
      attempts++;
      try {
        const res = await fetchFn(
          `/api/persona/result?inquiry_id=${encodeURIComponent(personaInquiryId)}`,
        );
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as {
            ready?: boolean;
            status?: string;
            credentials?: Credential[];
            error?: string;
          } | null;

          if (
            data?.ready &&
            Array.isArray(data.credentials) &&
            data.credentials.length > 0
          ) {
            await handleSuccess(data.credentials);
            return;
          }
          if (data?.status === "failed") {
            throw new Error(data.error ?? "Identity verification failed");
          }
        }
      } catch (e) {
        if (cancelled) return;
        handleError((e as Error).message);
        return;
      }

      // If pending and still within attempts limit, schedule next poll
      if (attempts < maxPollAttempts) {
        pollTimeout = setTimeout(pollResult, pollIntervalMs);
      } else {
        // Fallback to synchronous /api/issue if async webhook hasn't fulfilled
        try {
          const res = await fetchFn("/api/issue", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-request-id": requestId,
            },
            body: JSON.stringify({
              ...pending,
              persona_inquiry_id: personaInquiryId,
            }),
          });
          if (!res.ok) {
            const d = (await res.json().catch(() => null)) as {
              error?: string;
            } | null;
            throw new Error(
              d?.error ?? "Issuing failed after identity verification",
            );
          }
          const { credentials } = (await res.json()) as {
            credentials: Credential[];
          };
          await handleSuccess(credentials);
        } catch (e) {
          if (cancelled) return;
          handleError((e as Error).message);
        }
      }
    };

    pollResult();

    return () => {
      cancelled = true;
      if (pollTimeout) clearTimeout(pollTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaInquiryId, address]);

  return {
    isResuming,
    error,
    setError,
  };
}
