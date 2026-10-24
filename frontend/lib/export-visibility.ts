import type { Credential } from "./credential";
import { STORAGE_KEYS } from "./storage-keys";

export const EXPORT_PII_FIELDS = ["value", "holder"] as const;

export type ExportPiiField = (typeof EXPORT_PII_FIELDS)[number];

export type ExportVisibilityPreferences = Record<ExportPiiField, boolean>;

export type ExportCredential = Omit<Credential, ExportPiiField> &
  Partial<Pick<Credential, ExportPiiField>>;

export const DEFAULT_EXPORT_VISIBILITY_PREFERENCES: Readonly<ExportVisibilityPreferences> =
  Object.freeze({ value: true, holder: true });

function parseExportVisibilityPreferences(raw: string): ExportVisibilityPreferences {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Export visibility preferences are corrupted. Reset them before exporting.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Export visibility preferences are invalid. Reset them before exporting.");
  }

  const settings = parsed as Record<string, unknown>;
  const preferences = { ...DEFAULT_EXPORT_VISIBILITY_PREFERENCES };
  for (const field of EXPORT_PII_FIELDS) {
    const setting = settings[field];
    if (setting !== undefined && typeof setting !== "boolean") {
      throw new Error(`Export visibility preference "${field}" must be a boolean.`);
    }
    if (typeof setting === "boolean") preferences[field] = setting;
  }
  return preferences;
}

export function getExportVisibilityPreferences(): ExportVisibilityPreferences {
  if (typeof window === "undefined") {
    return { ...DEFAULT_EXPORT_VISIBILITY_PREFERENCES };
  }

  const raw = window.localStorage.getItem(STORAGE_KEYS.EXPORT_VISIBILITY);
  // Missing preferences mean a pre-existing profile; retain the old export behavior.
  return raw === null
    ? { ...DEFAULT_EXPORT_VISIBILITY_PREFERENCES }
    : parseExportVisibilityPreferences(raw);
}

export function saveExportVisibilityPreferences(preferences: ExportVisibilityPreferences): void {
  for (const field of EXPORT_PII_FIELDS) {
    if (typeof preferences[field] !== "boolean") {
      throw new TypeError(`Export visibility preference "${field}" must be a boolean.`);
    }
  }
  if (typeof window === "undefined") {
    throw new Error("Export visibility preferences can only be saved in a browser.");
  }

  window.localStorage.setItem(STORAGE_KEYS.EXPORT_VISIBILITY, JSON.stringify(preferences));
}

/** Omit opted-out PII keys from each credential before it enters an export format. */
export function filterCredentialForExport(
  credential: Credential,
  preferences: ExportVisibilityPreferences = getExportVisibilityPreferences(),
): ExportCredential {
  const exported: ExportCredential = { ...credential };
  if (!preferences.value) delete exported.value;
  if (!preferences.holder) delete exported.holder;
  return exported;
}

export function filterCredentialsForExport(
  credentials: Credential[],
  preferences: ExportVisibilityPreferences = getExportVisibilityPreferences(),
): ExportCredential[] {
  return credentials.map((credential) => filterCredentialForExport(credential, preferences));
}
