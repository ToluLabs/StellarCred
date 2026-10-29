/**
 * Lightweight Node tests for theme resolution (no vitest dependency).
 * Run: pnpm test:theme
 * (node --import tsx --test; uses node:test)
 *
 * These exercise the pure storage/OS precedence rules used by ThemeToggle
 * and THEME_BOOT_SCRIPT.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

type DomGlobals = {
  window?: unknown;
  document?: unknown;
};

const g = globalThis as unknown as DomGlobals;

// Minimal browser stubs for SSR-safe helpers
const store = new Map<string, string>();

interface StubElement {
  attrs: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
}

function installDomStubs(systemDark: boolean) {
  g.window = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
    matchMedia: (query: string) => ({
      matches: query.includes("dark") ? systemDark : !systemDark,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
      onchange: null,
    }),
  };
  const documentElement: StubElement = {
    attrs: {},
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
  };
  g.document = { documentElement };
}

function rootAttr(name: string): string | null {
  const doc = g.document as { documentElement: StubElement };
  return doc.documentElement.getAttribute(name);
}

describe("theme helpers", async () => {
  // Dynamic import after stubs so module code can see window when called
  const { getStoredTheme, getSystemTheme, resolveTheme, setExplicitTheme, applyTheme, THEME_BOOT_SCRIPT } =
    await import("./theme.ts");

  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    store.clear();
  });

  it("follows OS when no stored theme (dark)", () => {
    installDomStubs(true);
    assert.equal(getStoredTheme(), null);
    assert.equal(getSystemTheme(), "dark");
    assert.equal(resolveTheme(), "dark");
  });

  it("follows OS when no stored theme (light)", () => {
    installDomStubs(false);
    assert.equal(resolveTheme(), "light");
  });

  it("explicit stored theme wins over OS", () => {
    installDomStubs(true);
    store.set("theme", "light");
    assert.equal(getStoredTheme(), "light");
    assert.equal(resolveTheme(), "light");
  });

  it("ignores invalid stored values", () => {
    installDomStubs(true);
    store.set("theme", "neon");
    assert.equal(getStoredTheme(), null);
    assert.equal(resolveTheme(), "dark");
  });

  it("setExplicitTheme persists and applies", () => {
    installDomStubs(false);
    setExplicitTheme("dark");
    assert.equal(store.get("theme"), "dark");
    assert.equal(rootAttr("data-theme"), "dark");
  });

  it("applyTheme sets data-theme without writing storage", () => {
    installDomStubs(true);
    applyTheme("light");
    assert.equal(store.has("theme"), false);
    assert.equal(rootAttr("data-theme"), "light");
  });

  it("boot script prefers stored theme then OS", () => {
    assert.match(THEME_BOOT_SCRIPT, /localStorage\.getItem\("theme"\)/);
    assert.match(THEME_BOOT_SCRIPT, /prefers-color-scheme: dark/);
    assert.match(THEME_BOOT_SCRIPT, /setAttribute\("data-theme"/);
  });
});
