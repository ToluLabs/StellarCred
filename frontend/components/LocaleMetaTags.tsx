"use client";

import { useLocale } from "next-intl";
import { usePathname } from "next/navigation";
import { locales, type Locale } from "@/i18n.config";

/**
 * Component that adds hreflang meta tags for SEO
 * Declares alternate language versions of the current page
 * 
 * Note: Uses window.location.origin to make it domain-agnostic
 */
export function LocaleMetaTags() {
  const locale = useLocale() as Locale;
  const pathname = usePathname();

  // Get the path without locale prefix for constructing alternate URLs
  const getPathForLocale = (targetLocale: Locale): string => {
    // Remove current locale from path
    let relativePath = pathname;
    if (pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`) {
      relativePath = pathname.slice(locale.length + 1) || "/";
    }

    // Add target locale (only if not default 'en')
    if (targetLocale === "en") {
      return relativePath || "/";
    }
    return `/${targetLocale}${relativePath === "/" ? "" : relativePath}`;
  };

  // Get base URL from window (client-side only)
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <>
      {/* Current page's canonical URL */}
      {baseUrl && (
        <link rel="canonical" href={`${baseUrl}${getPathForLocale(locale)}`} />
      )}

      {/* Alternate language versions for SEO */}
      {locales.map((loc) => (
        baseUrl && (
          <link
            key={loc}
            rel="alternate"
            hrefLang={loc === "en" ? "en-US" : `${loc}-${loc.toUpperCase()}`}
            href={`${baseUrl}${getPathForLocale(loc)}`}
          />
        )
      ))}

      {/* x-default for fallback to English */}
      {baseUrl && (
        <link
          rel="alternate"
          hrefLang="x-default"
          href={`${baseUrl}/`}
        />
      )}
    </>
  );
}
