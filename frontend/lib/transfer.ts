"use client";

// Move a credential to another device via an encrypted QR code: the holder
// picks a passphrase, this encrypts the credential JSON with it (never the
// raw secret in cleartext — see lib/credential-crypto.ts), and embeds the
// ciphertext in a /holder?import=<payload> URL that the other device scans
// or opens.

import { parseCredential, type Credential } from "./credential";
import {
  encryptWithPassphrase,
  decryptWithPassphrase,
  DecryptionError,
} from "./credential-crypto";

export { DecryptionError };

const BASE_URL = process.env.NEXT_PUBLIC_STELLARCRED_BASE_URL ?? "https://stellarcred.xyz";

/** Query param carrying the encrypted payload on /holder. */
export const IMPORT_PARAM = "import";

/**
 * Encrypts `cred` with `passphrase` and returns an absolute URL encoding the
 * transfer. `origin` overrides the base (pass `window.location.origin` so the
 * link works against whichever host is actually serving the app).
 */
export async function buildTransferUrl(
  cred: Credential,
  passphrase: string,
  origin: string = BASE_URL,
): Promise<string> {
  const payload = await encryptWithPassphrase(JSON.stringify(cred), passphrase);
  const url = new URL("/holder", origin);
  url.searchParams.set(IMPORT_PARAM, payload);
  return url.toString();
}

/** Reverses buildTransferUrl's encryption. Throws DecryptionError on a wrong passphrase. */
export async function decryptTransferPayload(payload: string, passphrase: string): Promise<Credential> {
  const json = await decryptWithPassphrase(payload, passphrase);
  return parseCredential(json);
}
