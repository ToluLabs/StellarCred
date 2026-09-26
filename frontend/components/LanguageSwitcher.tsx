"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useLocale } from "next-intl";
import { IconLanguage, IconChevronDown, IconCheck } from "@tabler/icons-react";
import { locales, localeNames, type Locale } from "@/i18n.config";

/**
 * Language Switcher Component
 * 
 * Allows users to switch between available locales (en, es).
 * - Stores preference in localStorage for persistence
 * - Updates URL pathname to navigate to locale-specific route
 * - Shows current language with a checkmark
 * - Accessible keyboard navigation (Escape to close, arrow keys to navigate)
 */
export function LanguageSwitcher() {
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Only render on client to avoid hydration mismatches
  useEffect(() => {
    setMounted(true);
  }, []);

  // Close dropdown on outside click or Escape
  useEffect(() => {
    if (!isOpen || !mounted) return;

    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener("click", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, mounted]);

  const handleLocaleChange = (newLocale: Locale) => {
    if (newLocale === locale) {
      setIsOpen(false);
      return;
    }

    // Save preference to localStorage
    if (typeof window !== "undefined") {
      localStorage.setItem("preferred-locale", newLocale);
    }

    // Remove current locale prefix from pathname if present
    let newPathname = pathname;
    if (pathname.startsWith(`/${locale}/`) || pathname === `/${locale}`) {
      // Remove the locale prefix from the start
      newPathname = pathname.slice(locale.length + 1) || "/";
    }

    // Add new locale prefix for non-default locales
    if (newLocale !== "en") {
      newPathname = `/${newLocale}${newPathname === "/" ? "" : newPathname}`;
    }

    setIsOpen(false);
    router.push(newPathname);
  };

  if (!mounted) {
    return null;
  }

  return (
    <div
      ref={dropdownRef}
      style={{ position: "relative" }}
      className="language-switcher"
    >
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className="btn btn-ghost"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.4rem",
          fontSize: "0.85rem",
          padding: "0.4rem 0.6rem",
        }}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        title={`Current language: ${localeNames[locale]}`}
      >
        <IconLanguage size={16} stroke={1.8} />
        <span>{localeNames[locale]}</span>
        <IconChevronDown
          size={14}
          stroke={1.8}
          style={{
            transition: "transform 0.2s",
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
      </button>

      {isOpen && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: "0.4rem",
            minWidth: 160,
            background: "var(--bg-raised)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
            zIndex: 1000,
            overflow: "hidden",
          }}
        >
          {locales.map((loc) => (
            <button
              key={loc}
              role="option"
              aria-selected={loc === locale}
              onClick={() => handleLocaleChange(loc)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.6rem 0.9rem",
                border: "none",
                background: loc === locale ? "var(--bg-soft)" : "transparent",
                color: "var(--text)",
                fontSize: "0.85rem",
                cursor: "pointer",
                textAlign: "left",
                transition: "background-color 0.15s",
              }}
              onMouseEnter={(e) => {
                if (loc !== locale) {
                  e.currentTarget.style.backgroundColor = "var(--bg-soft)";
                }
              }}
              onMouseLeave={(e) => {
                if (loc !== locale) {
                  e.currentTarget.style.backgroundColor = "transparent";
                }
              }}
            >
              <span>{localeNames[loc]}</span>
              {loc === locale && (
                <IconCheck
                  size={16}
                  stroke={2}
                  style={{ color: "var(--accent)", flexShrink: 0 }}
                />
              )}
            </button>
          ))}
        </div>
      )}

      <style jsx>{`
        .language-switcher button:hover {
          background-color: var(--bg-soft);
        }
      `}</style>
    </div>
  );
}
