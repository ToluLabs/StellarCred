"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_EXPORT_VISIBILITY_PREFERENCES,
  EXPORT_PII_FIELDS,
  getExportVisibilityPreferences,
  saveExportVisibilityPreferences,
  type ExportPiiField,
  type ExportVisibilityPreferences,
} from "@/lib/export-visibility";

const FIELD_LABELS: Record<ExportPiiField, string> = {
  value: "Sensitive credential attribute value",
  holder: "Holder wallet address",
};

export function ExportVisibilitySettings() {
  const [preferences, setPreferences] = useState<ExportVisibilityPreferences | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      // Read localStorage after hydration to avoid server/client markup mismatches.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreferences(getExportVisibilityPreferences());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load export preferences.");
    }
  }, []);

  function updatePreference(field: ExportPiiField, include: boolean) {
    if (!preferences) return;
    const next = { ...preferences, [field]: include };
    try {
      saveExportVisibilityPreferences(next);
      setPreferences(next);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save export preferences.");
    }
  }

  function resetPreferences() {
    try {
      saveExportVisibilityPreferences({ ...DEFAULT_EXPORT_VISIBILITY_PREFERENCES });
      setPreferences({ ...DEFAULT_EXPORT_VISIBILITY_PREFERENCES });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset export preferences.");
    }
  }

  return (
    <section aria-labelledby="export-visibility-title" className="stack" style={{ gap: "0.55rem" }}>
      <h3 id="export-visibility-title" style={{ margin: 0, fontSize: "0.9rem" }}>
        Export field visibility
      </h3>
      <p
        className="faint"
        style={{ fontSize: "0.75rem", maxWidth: 560, lineHeight: 1.6, margin: 0 }}
      >
        Clear a field to omit it from credential backups, encrypted transfers, and Guardian recovery
        exports. An export missing either field cannot fully restore or prove that credential.
        History exports contain proof metadata only.
      </p>
      {EXPORT_PII_FIELDS.map((field) => (
        <label
          key={field}
          style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8125rem" }}
        >
          <input
            type="checkbox"
            checked={preferences?.[field] ?? true}
            disabled={!preferences}
            onChange={(event) => updatePreference(field, event.target.checked)}
          />
          Include {FIELD_LABELS[field]}
        </label>
      ))}
      {error && (
        <div role="alert" style={{ color: "var(--danger)", fontSize: "0.75rem" }}>
          <p style={{ margin: "0 0 0.4rem" }}>{error}</p>
          <button className="btn btn-ghost btn-sm" onClick={resetPreferences}>
            Reset preferences to include all fields
          </button>
        </div>
      )}
    </section>
  );
}
