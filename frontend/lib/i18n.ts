export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export function getLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const stored = localStorage.getItem("sc_locale") as Locale | null;
  if (stored && locales.includes(stored)) return stored;
  const browser = navigator.language.slice(0, 2) as Locale;
  return locales.includes(browser) ? browser : defaultLocale;
}

export function setLocale(locale: Locale) {
  localStorage.setItem("sc_locale", locale);
}
