"use client";

import { useEffect, useState } from "react";
import { IconSun, IconMoon } from "@tabler/icons-react";

export function ThemeToggle() {
   const [activeTheme, setActiveTheme] = useState<string>(() => {
    if (typeof document !== "undefined") {
      return document.documentElement.getAttribute("data-theme") || "dark";
    }
    return "dark";
  });

  useEffect(() => {
    const currentTheme =
      document.documentElement.getAttribute("data-theme") || "dark";
    setActiveTheme(currentTheme);
  }, []);

  const toggleTheme = () => {
    const root = document.documentElement;
    const currentTheme = root.getAttribute("data-theme");
    const newTheme = currentTheme === "light" ? "dark" : "light";

    root.setAttribute("data-theme", newTheme);
    localStorage.setItem("theme", newTheme);
    setActiveTheme(newTheme);
  };

  const ariaLabel =
    activeTheme === "light" ? "Switch to dark mode" : "Switch to light mode";

  return (
    <button
      onClick={toggleTheme}
      id="theme-toggle"
      aria-label={ariaLabel}
      style={{
        background: "none",
        border: "none",
        padding: "0.25rem 0.5rem",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--muted)",
      }}
    >
      <span className="sun-icon">
        <IconSun size={15} stroke={1.8} />
      </span>
      <span className="moon-icon">
        <IconMoon size={15} stroke={1.8} />
      </span>
    </button>
  );
}
