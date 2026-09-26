"use client";

import { useEffect, useState } from "react";
import { IconSun, IconMoon } from "@tabler/icons-react";
import {
  applyTheme,
  getStoredTheme,
  resolveTheme,
  setExplicitTheme,
  type Theme,
} from "@/lib/theme";

/**
 * Header theme control.
 *
 * - First visit (no `localStorage.theme`): follows `prefers-color-scheme`.
 * - After the user toggles: choice is persisted and OS changes are ignored.
 * - While no explicit choice exists: live-syncs when the OS theme changes.
 *
 * The matching no-flash boot script lives in `app/layout.tsx` (see
 * `THEME_BOOT_SCRIPT` in `@/lib/theme`).
 */
export function ThemeToggle() {
  const [activeTheme, setActiveTheme] = useState<Theme>("dark");

  useEffect(() => {
    // Align React state with whatever the boot script (or a prior paint) set.
    const initial = resolveTheme();
    applyTheme(initial);
    setActiveTheme(initial);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onOsThemeChange = () => {
      // Explicit user choice always wins — only follow OS when unset.
      if (getStoredTheme() !== null) return;
      const next: Theme = media.matches ? "dark" : "light";
      applyTheme(next);
      setActiveTheme(next);
    };

    // Safari < 14 used addListener/removeListener.
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onOsThemeChange);
      return () => media.removeEventListener("change", onOsThemeChange);
    }
    media.addListener(onOsThemeChange);
    return () => media.removeListener(onOsThemeChange);
  }, []);

  const toggleTheme = () => {
    const next: Theme = activeTheme === "light" ? "dark" : "light";
    setExplicitTheme(next);
    setActiveTheme(next);
  };

  const ariaLabel =
    activeTheme === "light" ? "Switch to dark mode" : "Switch to light mode";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      id="theme-toggle"
      aria-label={ariaLabel}
      aria-pressed={activeTheme === "dark"}
      className="theme-toggle-btn"
    >
      <span className="sun-icon" aria-hidden="true">
        <IconSun size={15} stroke={1.8} />
      </span>
      <span className="moon-icon" aria-hidden="true">
        <IconMoon size={15} stroke={1.8} />
      </span>
    </button>
  );
}
