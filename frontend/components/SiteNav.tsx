"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { IconBook2, IconCode } from "@tabler/icons-react";
import { LangSwitcher } from "@/components/LangSwitcher";
import { IconBook2, IconCode, IconMenu2, IconX } from "@tabler/icons-react";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { href: "/holder", label: "Wallet" },
  { href: "/verify", label: "Verify" },
  { href: "/issuer", label: "Issuer" },
  { href: "/apps", label: "Apps" },
];

function ShieldIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden>
      <path
        d="M11 2.5L4 5.5v5.25c0 4.97 3.253 9.63 7 10.75 3.747-1.12 7-5.78 7-10.75V5.5L11 2.5z"
        fill="rgba(62,207,142,0.12)"
        stroke="#3ecf8e"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 11.2l2.1 2.1 4-4"
        stroke="#3ecf8e"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SiteNav() {
  const pathname = usePathname();
  const t = useTranslations("nav");

  const LINKS = [
    { href: "/holder", label: t("wallet") },
    { href: "/verify", label: t("verify") },
    { href: "/issuer", label: t("issuer") },
    { href: "/apps",   label: t("apps") },
  ];
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => setMenuOpen(false), [pathname]);

  // Close on Escape or a click/tap outside the nav — standard disclosure
  // pattern behaviour. Only listens while the menu is actually open.
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
          StellarCred
        </Link>

        <button
          type="button"
          className="nav-toggle"
          aria-label="Toggle menu"
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
              className={pathname.startsWith(l.href) ? "active" : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div
          className="nav-right"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.25rem",
              padding: "0.25rem",
              borderRadius: "999px",
              border: "1px solid var(--border)",
              background: "rgba(255,255,255,0.02)",
            }}
          >
            <Link
              href="/docs"
              className={`seg-link${pathname.startsWith("/docs") ? " active" : ""}`}
            >
              <IconBook2 size={14} stroke={1.8} />
              {t("docs")}
            </Link>
            <Link
              href="/developers"
              className={`seg-link${pathname.startsWith("/developers") ? " active" : ""}`}
            >
              <IconCode size={14} stroke={1.8} />
              {t("developers")}
            </Link>
          </div>

          <LangSwitcher />
        <div id="mobile-nav-right" className="nav-right">
          <Link
            href="/docs"
            className={`seg-link${pathname.startsWith("/docs") ? " active" : ""}`}
          >
            <IconBook2 size={14} stroke={1.8} />
            Docs
          </Link>
          <Link
            href="/developers"
            className={`seg-link${pathname.startsWith("/developers") ? " active" : ""}`}
          >
            <IconCode size={14} stroke={1.8} />
            Developers
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
