"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { IconBook2, IconCode, IconMenu2, IconX, IconHelp } from "@tabler/icons-react";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { resetOnboarding } from "@/lib/onboarding";

function ShieldIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
      <path d="M11 2.5L4 5.5v5.25c0 4.97 3.253 9.63 7 10.75 3.747-1.12 7-5.78 7-10.75V5.5L11 2.5z" fill="rgba(62,207,142,0.12)" stroke="#3ecf8e" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 11.2l2.1 2.1 4-4" stroke="#3ecf8e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SiteNav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const t = useTranslations();

  // Build LINKS inside the component so labels are reactive to locale changes
  const LINKS = [
    { href: "/holder",  label: t("nav.wallet"),  id: "nav-holder" },
    { href: "/verify",  label: t("nav.verify"),  id: "nav-verify" },
    { href: "/issuer",  label: t("nav.issuer") },
    { href: "/apps",    label: t("nav.apps"),    id: "nav-apps" },
    { href: "/login",   label: t("nav.login"),   id: "nav-login" },
  ];

  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(e: PointerEvent) {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  return (
    <header ref={headerRef} className={`nav${menuOpen ? " menu-open" : ""}`}>
      <div className="nav-inner">
        <Link href="/" className="brand">
          <span className="brand-icon">
            <ShieldIcon />
          </span>
          {t("nav.brand")}
        </Link>

        <button
          type="button"
          className="nav-toggle"
          aria-label={t("nav.toggleMenu")}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav-links mobile-nav-right"
          onClick={() => setMenuOpen((o) => !o)}
        >
          {menuOpen ? <IconX size={18} stroke={1.8} /> : <IconMenu2 size={18} stroke={1.8} />}
        </button>

        <nav id="mobile-nav-links" className="nav-links">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              id={l.id}
              className={pathname.startsWith(l.href) ? "active" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div id="mobile-nav-right" className="nav-right">
          <button
            type="button"
            className="seg-link nav-reset-btn"
            onClick={() => {
              resetOnboarding();
            }}
            title="Replay onboarding tour"
          >
            <IconHelp size={14} stroke={1.8} />
            {t("nav.tour")}
          </button>
          <Link
            href="/docs"
            className={`seg-link${pathname.startsWith("/docs") ? " active" : ""}`}
          >
            <IconBook2 size={14} stroke={1.8} />
            {t("nav.docs")}
          </Link>
          <Link
            href="/developers"
            className={`seg-link${pathname.startsWith("/developers") ? " active" : ""}`}
          >
            <IconCode size={14} stroke={1.8} />
            {t("nav.developers")}
          </Link>
          <ThemeToggle />
          <LanguageSwitcher />
        </div>
      </div>
    </header>
  );
}
