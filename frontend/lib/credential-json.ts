import { parseCredential, type Credential } from "./credential";
import { validateImportPayload } from "./credential-import-bounds";

export function parseCredentialDocument(json: string): Credential | Credential[] {
  const value = validateImportPayload(json);
  if (Array.isArray(value)) {
    return value.map((credential) => parseCredential(JSON.stringify(credential)));
  }
  if (value && typeof value === "object" && "version" in value) {
    throw new Error(
      "Encrypted backup envelopes are not plaintext credential exports. Import them in the app with the backup passphrase.",
    );
  }
  return parseCredential(json);
}

export function serializeCredentialDocument(value: Credential | Credential[]): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
