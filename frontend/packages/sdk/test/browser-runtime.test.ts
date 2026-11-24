// @vitest-environment jsdom
/**
 * Browser target smoke test (#990).
 *
 * The SDK declares browsers (Chrome/Edge 103+, Firefox 100+, Safari 16+) as a
 * supported runtime in docs/SDK_RUNTIME_SUPPORT.md. A full cross-browser suite
 * is out of scope for this package, so CI runs this file under jsdom and also
 * proves the packaging boundary at the source level: only the Node-only
 * `./server` module may import `node:` built-ins.
 *
 * The static check in .github/scripts/check-sdk-runtime-support.mjs covers the
 * same boundary for the whole repository; keeping it here too means a local
 * `pnpm test` fails immediately when browser code starts depending on Node.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildVerifyUrl,
  configure,
  hasClaim,
  isConfigured,
  TimeoutError,
  validateCredential,
} from "../src/index";

// jsdom makes import.meta.url an http:// URL, so resolve from vitest's root.
const PACKAGE_DIR = process.cwd();
const SRC_DIR = resolve(PACKAGE_DIR, "src");

/** The only source file allowed to reach for Node built-ins (the ./server entry). */
const NODE_ONLY_SOURCES = new Set(["batch-verify.ts"]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") {
        files.push(...sourceFiles(full));
      }
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("browser runtime support (#990)", () => {
  it("loads the package entry point in a browser environment", () => {
    expect(typeof hasClaim).toBe("function");
    expect(typeof configure).toBe("function");
    expect(typeof validateCredential).toBe("function");
    expect(TimeoutError.prototype).toBeInstanceOf(Error);
  });

  it("runs configuration and URL construction without Node globals", () => {
    configure({ registryId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4" });

    expect(isConfigured()).toBe(true);

    const url = buildVerifyUrl({
      returnUrl: "https://example.com/callback",
      claim: "age",
      threshold_years: 18,
      baseUrl: "https://stellarcred.example/verify",
    });
    expect(url.startsWith("https://stellarcred.example/verify?")).toBe(true);
    expect(url).toContain(encodeURIComponent("https://example.com/callback"));
  });

  it("keeps node: built-ins out of every browser-reachable source file", () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => {
        const name = relative(SRC_DIR, file).split(sep).join("/");
        if (NODE_ONLY_SOURCES.has(name)) return false;
        return /(?:from\s*|require\(\s*)["']node:/.test(readFileSync(file, "utf-8"));
      })
      .map((file) => relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });

  it("publishes a browser-safe default entry and a Node-only server entry", () => {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_DIR, "package.json"), "utf-8")) as {
      exports: Record<string, unknown>;
    };

    expect(pkg.exports).toHaveProperty(".");
    expect(pkg.exports).toHaveProperty("./testing");
    expect(pkg.exports).toHaveProperty("./server");
  });

  it("keeps the declared source tree free of missing files", () => {
    // Guards against a source move that leaves the boundary list stale: every
    // listed Node-only module must still exist.
    for (const name of NODE_ONLY_SOURCES) {
      expect(statSync(join(SRC_DIR, name)).isFile()).toBe(true);
    }
  });
});
