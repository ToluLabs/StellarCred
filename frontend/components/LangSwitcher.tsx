"use client";

import { useLocale, locales } from "@/lib/locale-context";

const LABELS: Record<string, string> = {
  en: "EN",
  es: "ES",
};

export function LangSwitcher() {
  const { locale, changeLocale } = useLocale();

  return (
    <div
      className="row"
      style={{
        gap: "0.15rem",
        padding: "0.2rem",
        borderRadius: "999px",
        border: "1px solid var(--border)",
        background: "rgba(255,255,255,0.02)",
      }}
      role="group"
      aria-label="Language"
    >
      {locales.map((l) => (
        <button
          key={l}
          onClick={() => changeLocale(l)}
          className={locale === l ? "seg-link active" : "seg-link"}
          aria-pressed={locale === l}
          style={{ fontWeight: locale === l ? 600 : 400, minWidth: 30 }}
        >
          {LABELS[l]}
        </button>
      ))}
    </div>
  );
}
