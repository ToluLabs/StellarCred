"use client";

import { useState } from "react";
import { useTransferImportParam } from "@/lib/hooks/useTransferImportParam";

export function useTransferQuery() {
  const [importPayload, setImportPayload] = useState<string | null>(null);

  // Keep this branch's stateful holder API while reusing main's extracted URL
  // import handling, including stripping the encrypted payload from history.
  useTransferImportParam(setImportPayload);

  return { importPayload, setImportPayload };
}
