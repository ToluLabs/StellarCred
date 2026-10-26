/**
 * Dependency PR detection and label resolution for auto-label-deps.yml.
 *
 * The workflow imports the pure helpers below and only performs the GitHub API
 * calls itself. Keeping detection in a plain module makes the behavior testable
 * and gives maintainers a dry-run without opening a test PR:
 *
 *   node .github/scripts/label-deps.mjs \
 *     --author "dependabot[bot]" \
 *     --branch "dependabot/npm_and_yarn/next-16" \
 *     --title "Bump next from 16.1.0 to 16.2.0" \
 *     --changed-files frontend/package.json,frontend/pnpm-lock.yaml
 *
 * Prints the classification, reasons, and resolved label as JSON.
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { MANIFEST_PATTERNS } from "./check-dep-bump-threshold.mjs";

/** Label applied when DEPENDENCY_LABEL_NAME is unset or empty. */
export const DEFAULT_DEPENDENCY_LABEL = "deps";

/** Bot accounts that only open dependency-update PRs. */
export const DEPENDENCY_BOT_AUTHORS = new Set([
  "dependabot[bot]",
  "dependabot-preview[bot]",
  "renovate[bot]",
  "renovate-bot",
]);

/** Branch prefixes used by Dependabot and Renovate. */
export const DEPENDENCY_BRANCH_PREFIXES = ["dependabot/", "renovate/"];

/**
 * Title formats emitted by Dependabot/Renovate or conventional dependency
 * commits. Deliberately narrower than "mentions deps" so docs about dependency
 * injection are not labelled as package updates.
 */
const DEPENDENCY_TITLE_PATTERNS = [
  /\b(?:build|chore|ci|fix|refactor)\(deps(?:-dev)?\)/i,
  /^bump\s+\S+\s+from\s+\S+\s+to\s+\S+/i,
  /^update\s+dependency\s+\S+\s+to\s+\S+/i,
  /^⬆️?\s*update\s+dependency\s+/i,
  /^update\s+(?:all\s+)?(?:non-major\s+)?dependencies\b/i,
  /\bdependency\s+(?:bump|update)\b/i,
];

/** Why a PR was classified as a dependency update. */
export const DEPENDENCY_REASONS = Object.freeze({
  AUTHOR: "author",
  BRANCH: "branch",
  TITLE: "title",
  CHANGED_FILES: "changed-files",
});

/**
 * Files whose presence indicates a dependency change: package manifests and
 * lockfiles, Cargo manifests, workspace config, and workflow files (Dependabot
 * also updates pinned Actions).
 *
 * The auto-merge manifest list is the source of truth for this repo; the extra
 * patterns cover nested workspace packages such as frontend/packages/sdk.
 */
export const DEPENDENCY_FILE_PATTERNS = [
  ...MANIFEST_PATTERNS,
  /(?:^|\/)package\.json$/,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)bun\.lockb?$/,
  /(?:^|\/)pnpm-workspace\.yaml$/,
  /(?:^|\/)go\.(?:mod|sum)$/,
];

/**
 * True when a changed path is a dependency manifest, lockfile, or workflow
 * file that a dependency bot would update.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isDependencyManifest(filePath) {
  if (typeof filePath !== "string") return false;
  const normalized = filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return false;

  return DEPENDENCY_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Classifies a pull request as a dependency update from its author, branch,
 * title, and (optionally) changed files.
 *
 * @param {{
 *   author?: string;
 *   branch?: string;
 *   title?: string;
 *   changedFiles?: readonly string[];
 * }} [input]
 * @returns {{ isDependency: boolean; reasons: string[] }}
 */
export function classifyDependencyPr(input = {}) {
  const author = normalize(input.author).toLowerCase();
  const branch = normalize(input.branch).toLowerCase();
  const title = normalize(input.title);
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : [];

  const reasons = [];

  if (DEPENDENCY_BOT_AUTHORS.has(author)) {
    reasons.push(DEPENDENCY_REASONS.AUTHOR);
  }
  if (DEPENDENCY_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
    reasons.push(DEPENDENCY_REASONS.BRANCH);
  }
  if (DEPENDENCY_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    reasons.push(DEPENDENCY_REASONS.TITLE);
  }
  if (changedFiles.some((file) => isDependencyManifest(file))) {
    reasons.push(DEPENDENCY_REASONS.CHANGED_FILES);
  }

  return { isDependency: reasons.length > 0, reasons };
}

/**
 * Resolves the label to apply, falling back to `deps` when the configured
 * repository variable is missing, empty, or whitespace-only.
 *
 * @param {string | undefined | null} configured
 * @returns {string}
 */
export function resolveDependencyLabel(configured) {
  if (typeof configured !== "string") return DEFAULT_DEPENDENCY_LABEL;
  const label = configured.trim();
  return label.length > 0 ? label : DEFAULT_DEPENDENCY_LABEL;
}

const USAGE = `Usage: node .github/scripts/label-deps.mjs [options]

Options:
  --author <login>          PR author login (e.g. "dependabot[bot]")
  --branch <name>           PR head branch (e.g. "renovate/next-16.x")
  --title <title>           PR title
  --changed-files <paths>   Comma-separated changed file paths; repeatable
  --label <name>            Configured label (default: deps)
  -h, --help                Show this help
`;

/**
 * Dry-run CLI. Prints the classification and resolved label; performs no
 * network calls and never throws for an ordinary non-dependency PR.
 *
 * @param {string[]} [argv]
 * @returns {void}
 */
export function runCli(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      author: { type: "string", default: "" },
      branch: { type: "string", default: "" },
      title: { type: "string", default: "" },
      "changed-files": { type: "string", multiple: true, default: [] },
      label: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const changedFiles = values["changed-files"]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  const classification = classifyDependencyPr({
    author: values.author,
    branch: values.branch,
    title: values.title,
    changedFiles,
  });

  console.log(
    JSON.stringify(
      {
        author: values.author,
        branch: values.branch,
        title: values.title,
        changedFiles,
        isDependency: classification.isDependency,
        reasons: classification.reasons,
        label: resolveDependencyLabel(values.label),
      },
      null,
      2,
    ),
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
