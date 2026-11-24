#!/usr/bin/env node

/**
 * Keep docs/COMPONENT_OWNERSHIP.md, .github/CODEOWNERS and the repository
 * structure in agreement (issue #993).
 *
 * Ownership documentation drifts in a way ordinary review misses: a directory
 * is renamed, a CODEOWNERS rule is narrowed, or a component row is deleted, and
 * the table still reads as authoritative. This check verifies relationships
 * rather than hunting for arbitrary words:
 *
 *   - the matrix contains exactly the six expected component rows;
 *   - every repository path listed as a component's scope exists;
 *   - every CODEOWNERS rule quoted by the matrix exists in CODEOWNERS;
 *   - each row's owners equal the owners CODEOWNERS resolves for its scope;
 *   - no owner handle is invented (all appear in CODEOWNERS);
 *   - every CODEOWNERS pattern still matches at least one tracked file.
 *
 * It does NOT verify GitHub branch protection or approval counts — those live in
 * repository settings, not in the clone. See § 6 of the document.
 *
 * Usage:
 *   node .github/scripts/check-component-ownership.mjs
 *   node .github/scripts/check-component-ownership.mjs --root <dir>
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DOC_PATH = "docs/COMPONENT_OWNERSHIP.md";
const CODEOWNERS_PATH = ".github/CODEOWNERS";
const START_MARKER = "<!-- ownership-matrix:start -->";
const END_MARKER = "<!-- ownership-matrix:end -->";

const EXPECTED_COMPONENTS = [
  "Contracts",
  "Circuits and VKs",
  "SDK and client bindings",
  "Frontend",
  "Issuer",
  "Indexer",
];

const IGNORED_DIRS = new Set([".git", "node_modules", "target", "dist", "build", "coverage"]);

function fail(message) {
  console.error(`::error::${message}`);
  return 1;
}

function parseArgs(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) return { root: resolve(dirname(fileURLToPath(import.meta.url)), "../..") };
  const value = argv[rootIndex + 1];
  if (!value) throw new Error("--root requires a directory");
  return { root: resolve(value) };
}

/** Tracked files where git is available, otherwise a filtered walk. */
function listFiles(root) {
  try {
    const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf-8" });
    return out.split("\n").filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else if (entry.isFile()) {
          files.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
        }
      }
    };
    walk(root);
    return files;
  }
}

function parseCodeowners(text) {
  const rules = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern && owners.length > 0) rules.push({ pattern, owners });
  }
  return rules;
}

function patternToRegex(pattern) {
  const anchored = pattern.startsWith("/");
  let body = anchored ? pattern.slice(1) : pattern;
  body = body.replace(/\/+$/, "");
  const escaped = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${escaped}$`);
}

/**
 * CODEOWNERS uses gitignore-style matching: a rule that matches a directory
 * applies to everything inside it, and the last matching rule wins.
 */
function matches(pattern, path) {
  const re = patternToRegex(pattern);
  const candidates = [path];
  const parts = path.split("/");
  for (let i = parts.length - 1; i > 0; i--) candidates.push(parts.slice(0, i).join("/"));
  return candidates.some((candidate) => re.test(candidate));
}

function resolveOwners(rules, path) {
  let owners = [];
  for (const rule of rules) {
    if (matches(rule.pattern, path)) owners = rule.owners;
  }
  return owners;
}

function parseMatrix(markdown) {
  const start = markdown.indexOf(START_MARKER);
  const end = markdown.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`matrix markers are missing from ${DOC_PATH}`);
  }

  const table = markdown.slice(start + START_MARKER.length, end).trim();
  const rows = table
    .split(/\r?\n/)
    .filter((line) => /^\|/.test(line.trim()))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );

  // Drop the header and the |---|---| separator.
  return rows.filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell))).slice(1);
}

function backticked(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
}

function stripDecorations(cell) {
  return cell.replace(/\*\*/g, "").trim();
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));

  const docFile = join(root, DOC_PATH);
  const codeownersFile = join(root, CODEOWNERS_PATH);
  if (!existsSync(docFile)) return fail(`${DOC_PATH} does not exist`);
  if (!existsSync(codeownersFile)) return fail(`${CODEOWNERS_PATH} does not exist`);

  const markdown = readFileSync(docFile, "utf-8");
  const rules = parseCodeowners(readFileSync(codeownersFile, "utf-8"));
  if (rules.length === 0) return fail(`${CODEOWNERS_PATH} contains no ownership rules`);

  const files = listFiles(root);
  const errors = [];

  let rows;
  try {
    rows = parseMatrix(markdown);
  } catch (error) {
    return fail(error.message);
  }

  if (rows.length !== EXPECTED_COMPONENTS.length) {
    errors.push(
      `matrix has ${rows.length} component row(s), expected ${EXPECTED_COMPONENTS.length}: ${EXPECTED_COMPONENTS.join(", ")}`,
    );
  }

  const seen = new Set();
  const documentedHandles = new Set(
    [...markdown.matchAll(/@[A-Za-z0-9][A-Za-z0-9-]*/g)].map((m) => m[0]),
  );
  const codeownerHandles = new Set(rules.flatMap((rule) => rule.owners));

  for (const component of EXPECTED_COMPONENTS) {
    if (!rows.some((row) => stripDecorations(row[0]) === component)) {
      errors.push(`missing component row: ${component}`);
    }
  }

  for (const row of rows) {
    const component = stripDecorations(row[0] ?? "");
    if (seen.has(component)) errors.push(`duplicate component row: ${component}`);
    seen.add(component);

    if (row.length !== 5) {
      errors.push(
        `${component}: expected 5 columns (component, scope, owner, CODEOWNERS rule, review path), got ${row.length}`,
      );
      continue;
    }

    const [, scopeCell, ownerCell, ruleCell] = row;
    const owners = [...ownerCell.matchAll(/@[A-Za-z0-9][A-Za-z0-9-]*/g)].map((m) => m[0]);
    if (owners.length === 0) errors.push(`${component}: no owner handle in the owner column`);

    // Scope: every backticked token that looks like a repository path must exist.
    const scopePaths = backticked(scopeCell).filter(
      (token) => !token.startsWith("@") && !/\s/.test(token),
    );
    if (scopePaths.length === 0)
      errors.push(`${component}: no repository paths in the scope column`);
    for (const token of scopePaths) {
      const relativePath = token.replace(/^\.?\//, "").replace(/\/+$/, "");
      if (relativePath && !existsSync(join(root, relativePath))) {
        errors.push(`${component}: documented path does not exist: ${token}`);
      }
    }

    // Rules: every quoted pattern must still be a literal CODEOWNERS pattern.
    const declaredRules = backticked(ruleCell).filter((token) => token.startsWith("/"));
    if (declaredRules.length === 0)
      errors.push(`${component}: no CODEOWNERS rules in the rule column`);
    for (const pattern of declaredRules) {
      if (!rules.some((rule) => rule.pattern === pattern)) {
        errors.push(`${component}: CODEOWNERS rule not found: ${pattern}`);
      }
    }

    // Owners: CODEOWNERS' resolution for the first scope path must match the row.
    const representative = scopePaths
      .map((token) => token.replace(/^\.?\//, "").replace(/\/+$/, ""))
      .find((token) => token && existsSync(join(root, token)));
    if (representative) {
      const resolved = [...new Set(resolveOwners(rules, representative))].sort();
      const documented = [...new Set(owners)].sort();
      if (resolved.length > 0 && JSON.stringify(resolved) !== JSON.stringify(documented)) {
        errors.push(
          `${component}: owner column (${documented.join(" ")}) does not match CODEOWNERS for ${representative} (${resolved.join(" ")})`,
        );
      }
    }
  }

  for (const handle of documentedHandles) {
    if (!codeownerHandles.has(handle))
      errors.push(`owner handle ${handle} is not listed in ${CODEOWNERS_PATH}`);
  }

  for (const rule of rules) {
    if (!files.some((file) => matches(rule.pattern, file))) {
      errors.push(`CODEOWNERS pattern matches no tracked file: ${rule.pattern}`);
    }
  }

  if (errors.length > 0) {
    console.error(`check-component-ownership: ${errors.length} problem(s) found.`);
    for (const message of errors) console.error(`::error::${message}`);
    console.error(
      "\nFix docs/COMPONENT_OWNERSHIP.md and .github/CODEOWNERS in the same change. " +
        "The matrix must keep all six components, real paths, real CODEOWNERS rules, " +
        "and the owners those rules resolve to.",
    );
    return 1;
  }

  console.log(
    `check-component-ownership: OK — ${rows.length} component(s), ${rules.length} CODEOWNERS rule(s), ${files.length} tracked file(s).`,
  );
  return 0;
}

process.exit(main());
