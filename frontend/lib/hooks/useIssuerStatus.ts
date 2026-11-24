"use client";

// Background issuer-status checker (GitHub #626).
//
// Runs once per wallet session — when the holder page mounts and an address
// is available — and checks every credential's issuer against IssuerRegistry
// via read-only Soroban simulation. The result is written back into each
// credential's `issuerStatus` / `issuerStatusCheckedAt` fields and persisted
// to localStorage so the signal survives page reloads.
//
// The check is re-skipped when the stored status is less than RECHECK_SECS
// old, so the network is not hammered on every render. It is always re-run
// when the status was "issuer_revoked" or "key_revoked" (anything that
// requires user action) in case the admin has since fixed the situation.
//
// Errors are swallowed — a failing issuer check must never prevent the holder
// page from loading or proving. The UI falls back to treating "unknown" the
// same as "active" so no credential is silently blocked.

import { useEffect, useRef } from "react";
import type { Credential } from "../credential";
import { checkIssuerStatus } from "../issuer-registry";
import { saveCredential } from "../credential";

/** Re-check after this many seconds even when the cached status is good. */
const RECHECK_SECS = 5 * 60; // 5 minutes

/** Always re-check if the previous result was one of these (needs user action). */
const ALWAYS_RECHECK: Array<Credential["issuerStatus"]> = [
  "issuer_revoked",
  "key_revoked",
  "unknown",
];

/**
 * Checks issuer status for all `creds` in the background once `address` is
 * available. Calls `onUpdate` when any credential's status changed so the
 * parent can refresh from storage.
 *
 * Safe to call repeatedly — an in-flight guard prevents concurrent passes.
 */
export function useIssuerStatus(
  creds: Credential[],
  address: string | null | undefined,
  onUpdate: () => void,
): void {
  // Stable refs so the effect never goes stale without re-running.
  const credsRef = useRef(creds);
  credsRef.current = creds;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const checkingRef = useRef(false);

  // Derive a stable key from credential identities so the effect only
  // re-fires when the credential set actually changes, not on every render.
  const credsKey = creds.map((c) => c.commitment).join(",");

  useEffect(() => {
    if (!address) return;
    // Capture the narrowed string so the async closure sees `string`, not
    // `string | null | undefined`. TypeScript cannot narrow through async
    // closures, so this explicit capture is required.
    const account: string = address;

    async function run() {
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        const now = Math.floor(Date.now() / 1000);
        let anyChanged = false;

        for (const cred of credsRef.current) {
          const stale =
            !cred.issuerStatusCheckedAt ||
            now - cred.issuerStatusCheckedAt > RECHECK_SECS;
          const actionRequired = ALWAYS_RECHECK.includes(cred.issuerStatus);

          if (!stale && !actionRequired) continue;
          if (!cred.issuerId || !cred.issuerPubX || !cred.issuerPubY) continue;

          let status: Credential["issuerStatus"];
          try {
            status = await checkIssuerStatus(
              cred.issuerId,
              cred.type,
              cred.issuerPubX,
              cred.issuerPubY,
              account,
            );
          } catch {
            status = "unknown";
          }

          const changed =
            status !== cred.issuerStatus || !cred.issuerStatusCheckedAt;
          await saveCredential({
            ...cred,
            issuerStatus: status,
            issuerStatusCheckedAt: now,
          });
          if (changed) anyChanged = true;
        }

        if (anyChanged) onUpdateRef.current();
      } finally {
        checkingRef.current = false;
      }
    }

    void run();
    // address and credsKey are the real triggers; refs handle the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, credsKey]);
}
