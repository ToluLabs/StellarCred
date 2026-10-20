#!/usr/bin/env node
// Coverage gate for the CI `coverage-gate` job (completes #755's wiring).
//
// Aggregates every istanbul `coverage-summary.json` produced by the
// frontend (vitest json-summary) and indexer (jest json-summary) jobs and
// compares the global totals against the MIN_* thresholds supplied through
// the environment. Exits non-zero with a per-metric report when any metric
// falls below its floor.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const COVERAGE_DIR = process.env.COVERAGE_DIR ?? "coverage-artifacts";
const THRESHOLDS = {
  lines: Number(process.env.MIN_LINES ?? 0),
  functions: Number(process.env.MIN_FUNCTIONS ?? 0),
  branches: Number(process.env.MIN_BRANCHES ?? 0),
  statements: Number(process.env.MIN_STATEMENTS ?? 0),
};

function findSummaries(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findSummaries(full, found);
    else if (entry === "coverage-summary.json") found.push(full);
  }
  return found;
}

const totals = {
  lines: { total: 0, covered: 0 },
  functions: { total: 0, covered: 0 },
  branches: { total: 0, covered: 0 },
  statements: { total: 0, covered: 0 },
};

const files = findSummaries(COVERAGE_DIR);
if (files.length === 0) {
  console.error(
    `::error::No coverage-summary.json found under ${COVERAGE_DIR}. ` +
      "Did the frontend/indexer jobs run test:coverage and upload their artifacts?"
  );
  process.exit(1);
}

for (const file of files) {
  let summary;
  try {
    summary = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`::error::Failed to parse ${file}: ${err.message}`);
    process.exit(1);
  }
  const total = summary.total;
  if (!total) continue;
  for (const metric of Object.keys(totals)) {
    if (total[metric]) {
      totals[metric].total += total[metric].total ?? 0;
      totals[metric].covered += total[metric].covered ?? 0;
    }
  }
}

let failed = false;
console.log(`Coverage gate (${files.length} summary file(s) from ${COVERAGE_DIR}):`);
for (const [metric, threshold] of Object.entries(THRESHOLDS)) {
  const { total, covered } = totals[metric];
  const pct = total === 0 ? 100 : (covered / total) * 100;
  const ok = pct >= threshold;
  failed ||= !ok;
  console.log(
    `  ${ok ? "PASS" : "FAIL"} ${metric.padEnd(10)} ${pct.toFixed(2)}% ` +
      `(${covered}/${total}) >= ${threshold}%`
  );
}

if (failed) {
  console.error("::error::Coverage below thresholds.");
  process.exit(1);
}
console.log("Coverage thresholds met.");
