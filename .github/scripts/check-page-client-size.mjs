#!/usr/bin/env node
/**
 * CI guard: caps page-client file sizes so they can only shrink.
 *
 * Why this exists:
 *   HolderPageClient.tsx grew 1863 -> 1936 -> 2072 lines across two open
 *   issues asking for it to shrink. Refactors alone did not hold the line.
 *   This check is the enforcement: each page client has an agreed cap
 *   (current size at the time the guard landed). Any growth fails the build.
 *   As extraction work progresses, lower the cap in the CAPS map below.
 *
 * Usage:
 *   node .github/scripts/check-page-client-size.mjs
 *
 * Exit codes:
 *   0  -- all page clients are at or below their cap
 *   1  -- one or more page clients exceed their cap
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Agreed line caps per page-client file.
 *
 * These are set to the current size at the time the guard landed so
 * the files can only shrink. Lower a cap here once the corresponding
 * extraction issue completes.
 */
export const CAPS = {
  "frontend/app/holder/HolderPageClient.tsx": 506,
  "frontend/app/verify/VerifyPageClient.tsx": 316,
  "frontend/app/docs/DocsPageClient.tsx": 1145,
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Count lines in a file. A trailing newline does not count as an extra
 * line, matching the convention of `number of lines` in an editor.
 */
function countLines(content) {
  if (content.length === 0) return 0;
  const normalized = content.replace(/\r\n/g, "\n");
  const trailing = normalized.endsWith("\n") ? 1 : 0;
  return normalized.split("\n").length - trailing;
}

function main() {
  const entries = Object.entries(CAPS);
  const failures = [];
  const missing = [];
  const results = [];

  for (const [relPath, cap] of entries) {
    const absPath = resolve(REPO_ROOT, relPath);

    if (!existsSync(absPath)) {
      missing.push(relPath);
      continue;
    }

    const content = readFileSync(absPath, "utf-8");
    const lines = countLines(content);
    results.push({ relPath, lines, cap });

    if (lines > cap) {
      failures.push({ relPath, lines, cap });
    }
  }

  // Report the current size of every guarded file so the cap is visible.
  for (const { relPath, lines, cap } of results) {
    const status = lines > cap ? "FAIL" : "ok";
    console.log(`[${status}] ${relPath}: ${lines} / ${cap} lines`);
  }

  if (missing.length > 0) {
    console.error("\nCapped page-client files are missing from the repo:");
    for (const relPath of missing) {
      console.error(`  - ${relPath}`);
    }
    console.error(
      "\nIf a file was renamed or moved, update the CAPS map in .github/scripts/check-page-client-size.mjs.",
    );
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error("\nLINE CAP EXCEEDED:");
    for (const { relPath, lines, cap } of failures) {
      console.error(`\n  ${relPath}: ${lines} lines (cap ${cap}, over by ${lines - cap})`);
    }
    console.error(
      "\n\nThis file is at its agreed cap and can only shrink. Extract logic into \n" +
        "lib/hooks or components/holder (see #441) instead of adding to the page shell.",
    );
    process.exit(1);
  }

  console.log("\nAll page clients are at or below their cap.");
}

main();
