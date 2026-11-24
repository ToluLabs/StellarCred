import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

// Regression guard for #605: two extraction attempts (#378, #346) left data
// files under app/docs/ that no component ever imported. Every non-route file
// in app/docs must be consumed by production code, or it is dead code.

// import.meta.url is deliberately NOT used: under vitest's vite-node module
// runner it is a dev-server (non-file:) URL, so fileURLToPath throws there.
// Walk up from the working directory instead — pnpm test runs from frontend/,
// and the upward search also survives `vitest --root` invocations.
function findFrontendRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (
      existsSync(path.join(dir, "package.json")) &&
      existsSync(path.join(dir, "app", "docs"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("could not locate frontend root from " + process.cwd());
    }
    dir = parent;
  }
}

const FRONTEND_ROOT = findFrontendRoot();
const DOCS_DIR = path.join(FRONTEND_ROOT, "app", "docs");

const NEXT_ROUTE_BASENAMES = new Set([
  "page",
  "layout",
  "route",
  "error",
  "loading",
  "not-found",
  "icon",
  "apple-icon",
  "opengraph-image",
  "twitter-image",
  "sitemap",
  "robots",
]);

const SOURCE_EXTS = [".ts", ".tsx"];
const TRY_EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function isTestFile(file: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`);
}

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (SOURCE_EXTS.includes(path.extname(entry)) && !isTestFile(full)) {
      out.push(full);
    }
  }
  return out;
}

function collectDocsFiles(dir: string): string[] {
  return collectSourceFiles(dir).filter((file) => {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    // Next.js App Router convention files are entry points, not orphans.
    return !NEXT_ROUTE_BASENAMES.has(base);
  });
}

// Resolve an import specifier the way the bundler would for first-party code;
// returns null for external/absolute specifiers.
function resolveSpecifier(spec: string, importer: string): string | null {
  let target: string;
  if (spec.startsWith("@/")) {
    target = path.join(FRONTEND_ROOT, spec.slice(2));
  } else if (spec.startsWith(".")) {
    target = path.resolve(path.dirname(importer), spec);
  } else {
    return null;
  }
  for (const ext of TRY_EXTENSIONS) {
    const candidate = `${target}${ext}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT_SPEC_RE = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

function buildImportedSet(importers: string[]): Set<string> {
  const imported = new Set<string>();
  for (const importer of importers) {
    const source = readFileSync(importer, "utf8");
    for (const match of source.matchAll(IMPORT_SPEC_RE)) {
      const resolved = resolveSpecifier(match[1], importer);
      if (resolved && resolved !== importer) imported.add(resolved);
    }
  }
  return imported;
}

describe("app/docs has no orphaned data files (#605)", () => {
  const docsFiles = collectDocsFiles(DOCS_DIR);
  const importers = [
    ...collectSourceFiles(path.join(FRONTEND_ROOT, "app")),
    ...collectSourceFiles(path.join(FRONTEND_ROOT, "components")),
    ...collectSourceFiles(path.join(FRONTEND_ROOT, "lib")),
    ...collectSourceFiles(path.join(FRONTEND_ROOT, "src")),
  ];

  it("every non-route file under app/docs is imported by production code", () => {
    const imported = buildImportedSet(importers);
    const orphans = docsFiles.filter((file) => !imported.has(file));
    expect(
      orphans.map((f) => path.relative(FRONTEND_ROOT, f)),
      "Unreferenced files under app/docs are dead code; import or delete them."
    ).toEqual([]);
  });
});
