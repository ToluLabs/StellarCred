#!/usr/bin/env node

/**
 * Guard against process artifacts landing in the repository (issue #684).
 *
 * A file whose name says "SUMMARY", "STATUS_REPORT" or "PR_DESCRIPTION" documents
 * *how a change was made*, not *how the system works*. Such a document is finished
 * the moment its PR merges, and every later code edit makes it wrong while its name
 * still reads as authority. Contributors keep writing them despite review comments
 * asking for their removal, so this fails the PR that adds one.
 *
 * Only files ADDED by the PR are checked. The repository already carries legacy
 * process documents; removing them is separate cleanup, and a check that failed on
 * the whole tree would just be disabled.
 *
 * Intended content belongs in the PR description. Anything worth keeping after the
 * merge is documentation — move it into the doc that owns the topic.
 * See CONTRIBUTING.md §"Process documents belong in the PR description".
 *
 * Usage (CI passes both shas; see .github/workflows/ci.yml):
 *   BASE_SHA=<sha> HEAD_SHA=<sha> node .github/scripts/check-process-docs.mjs
 *   node .github/scripts/check-process-docs.mjs --files path1 path2   # test a list
 */

import { execFileSync } from "child_process";

// Matched against the file's basename, ignoring extension and case, so
// `IMPLEMENTATION_SUMMARY.md`, `frontend/I18N_TEST_SUMMARY.md` and
// `PUSH_COMPLETE.txt` are all caught while `README.md` never is.
const PROCESS_ARTIFACT_PATTERNS = [
  /implementation[-_]details/i,
  /implementation[-_]notes/i,
  /implementation[-_]summary/i,
  /[-_]test[-_]summary/i,
  /review[-_]summary/i,
  /status[-_]report/i,
  /^pr[-_]description/i,
  /^verification[-_]complete/i,
  /[-_]complete\.(md|txt)$/i,
  /^start[-_]here\.(md|txt)$/i,
  /^critical[-_]fix[-_]needed/i,
  /^ready[-_]for[-_]build/i,
  /^files[-_]modified/i,
];

// Durable documents that legitimately match a pattern above. Adding an entry here
// requires a reason: if a file is listed only because moving it was inconvenient,
// it is probably a process artifact with an allowlist entry instead.
const ALLOWED = {};

function isProcessArtifact(filePath) {
  if (filePath in ALLOWED) return false;
  const name = filePath.split("/").pop();
  return PROCESS_ARTIFACT_PATTERNS.some((re) => re.test(name));
}

function addedFiles(base, head) {
  // Three dots: diff the merge-base against the PR head, so the set is exactly
  // "files this PR adds" and a file that landed on main meanwhile isn't counted.
  const out = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=A", `${base}...${head}`],
    { encoding: "utf-8" },
  );
  return out.split("\n").filter(Boolean);
}

function main() {
  const filesArgIndex = process.argv.indexOf("--files");
  let files;

  if (filesArgIndex !== -1) {
    files = process.argv.slice(filesArgIndex + 1);
  } else {
    const { BASE_SHA: baseSha, GITHUB_BASE_REF: baseRef, HEAD_SHA: headSha } = process.env;
    const base = baseSha || (baseRef ? `origin/${baseRef}` : null);
    const head = headSha || "HEAD";

    if (!base) {
      console.warn(
        "check-process-docs: no BASE_SHA / GITHUB_BASE_REF in the environment, " +
          "so there is nothing to diff against. Skipping (CI always sets one).",
      );
      return 0;
    }

    try {
      files = addedFiles(base, head);
    } catch (err) {
      console.error(`check-process-docs: git diff against ${base} failed: ${err.message}`);
      return 1;
    }
  }

  const violations = files.filter(isProcessArtifact);

  if (violations.length > 0) {
    console.error(
      `check-process-docs: ${violations.length} new process artifact(s) — documents ` +
        `that describe how a change was made rather than how the system works.`,
    );
    for (const file of violations) {
      console.error(
        `::error::${file} is a process artifact ` +
          "(matches a SUMMARY / STATUS_REPORT / IMPLEMENTATION_NOTES / PR_DESCRIPTION pattern)",
      );
    }
    console.error(
      "\nMove the content into the pull request description, and relocate anything " +
        "that should outlive the merge into the doc that owns the topic " +
        "(circuits/README.md, docs/, the component's README.md).\n" +
        "Rationale: CONTRIBUTING.md §\"Process documents belong in the PR description\".\n" +
        "If a new durable document genuinely needs one of these names, add it with a " +
        "reason to ALLOWED in .github/scripts/check-process-docs.mjs and justify it in the PR.",
    );
    return 1;
  }

  console.log(`check-process-docs: OK — ${files.length} added file(s), no process artifacts.`);
  return 0;
}

process.exit(main());
