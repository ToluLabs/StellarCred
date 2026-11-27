import { parseCredential, type Credential } from "./credential";
import { validateImportPayload } from "./credential-import-bounds";

export function parseCredentialDocument(json: string): Credential | Credential[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Let the shared validator produce the bounded, actionable parse error.
    parsed = null;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "version" in parsed) {
    throw new Error(
      "Encrypted backup envelopes are not plaintext credential exports. Import them in the app with the backup passphrase.",
    );
  }

  // A single plaintext credential is a supported legacy export shape. Run it
  // through the same bounded array validator rather than bypassing import
  // limits; integrity-wrapped bundles continue down the normal bundle path.
  const isLegacySingle =
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    !("integrity" in parsed);
  const value = validateImportPayload(isLegacySingle ? JSON.stringify([parsed]) : json);
  if (Array.isArray(value)) {
    const credentials = value.map((credential) => parseCredential(JSON.stringify(credential)));
    return isLegacySingle ? credentials[0] : credentials;
  }
  return parseCredential(json);
}

export function serializeCredentialDocument(value: Credential | Credential[]): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
