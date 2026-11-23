"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { IMPORT_PARAM } from "@/lib/transfer";

export function useTransferQuery() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [importPayload, setImportPayload] = useState<string | null>(null);

  // A transfer QR opened directly (native camera app -> /holder?import=...)
  // lands here with the payload already in the URL — prompt for the
  // passphrase immediately, and strip it from the URL so a refresh or the
  // back button doesn't re-trigger the prompt or leave ciphertext in history.
  useEffect(() => {
    const payload = searchParams.get(IMPORT_PARAM);
    if (!payload) return;
    setImportPayload(payload);
    router.replace("/holder");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return { importPayload, setImportPayload };
}
