// frontend/lib/security/secureDownload.ts
//
// Compatibility façade over the shared auth module (lib/auth.ts).
//
// The secure-download token codec now lives in lib/auth.ts alongside every
// other credential primitive, so there is exactly one implementation of
// "sign a payload, verify it, reject it when expired". This file keeps the
// original import path and function names working for existing callers.

import {
  generateSecureDownloadUrl,
  getDownloadSigningSecret,
  verifyDownloadToken,
  type DownloadTokenPayload,
} from "../auth";

export { generateSecureDownloadUrl, getDownloadSigningSecret };
export type { DownloadTokenPayload };

/**
 * Validates a secure download token, verifying cryptographic signature and
 * expiration.
 */
export function verifySecureDownloadToken(token: string): {
  isValid: boolean;
  payload?: DownloadTokenPayload;
  error?: string;
} {
  const result = verifyDownloadToken(token);
  return { isValid: result.isValid, payload: result.payload, error: result.error };
}
