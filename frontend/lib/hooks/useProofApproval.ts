"use client";

/**
 * useProofApproval — holds a proof request until the holder approves it
 * (#1048).
 *
 * Proving starts as soon as the holder page switches to a proof view, so the
 * "Generate proof" and "Prove selected" buttons park the request here first.
 * The disclosure preview shows what the proof will share and what stays
 * private; only `approve` hands the request on to `start`.
 */

import { useCallback, useState } from "react";
import { type Credential } from "../credential";

export type ProofRequest =
  | { kind: "single"; cred: Credential }
  | { kind: "batch"; creds: Credential[] };

export function useProofApproval(start: (request: ProofRequest) => void) {
  const [pending, setPending] = useState<ProofRequest | null>(null);

  const request = useCallback((next: ProofRequest) => setPending(next), []);

  const approve = useCallback(() => {
    if (pending) start(pending);
    setPending(null);
  }, [pending, start]);

  const cancel = useCallback(() => setPending(null), []);

  /** Credentials awaiting approval, or null when no preview is open. */
  const creds: Credential[] | null = pending
    ? pending.kind === "single"
      ? [pending.cred]
      : pending.creds
    : null;

  return { pending, creds, request, approve, cancel };
}
