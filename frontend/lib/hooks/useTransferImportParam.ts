"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { IMPORT_PARAM } from "@/lib/transfer";

/**
 * A transfer QR opened directly (native camera app -> /holder?import=...)
 * lands here with the payload already in the URL — hand it to the caller
 * immediately, and strip it from the URL so a refresh or the back button
 * doesn't re-trigger the prompt or leave ciphertext in history.
 */
export function useTransferImportParam(onPayload: (payload: string) => void): void {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const payload = searchParams.get(IMPORT_PARAM);
    if (!payload) return;
    onPayload(payload);
    router.replace("/holder");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
}
