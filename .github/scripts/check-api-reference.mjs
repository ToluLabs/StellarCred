#!/usr/bin/env node

/**
 * API-reference drift check (issue #525).
 *
 * Guarantees docs/PROOF_REGISTRY_API.md stays in lockstep with the
 * ProofRegistry contract source:
 *
 *   1. Every `pub fn` entrypoint in contracts/proof_registry/src/lib.rs
 *      (inside a #[contractimpl] block, test module excluded) must have a
 *      `### \`fn_name\`` section in the reference documenting
 *      Audience, Auth and Panics.
 *   2. Every section in the reference must correspond to a real entrypoint
 *      (no stale sections after renames/removals).
 *   3. Every variant of the contract's `Error` enum must appear in the
 *      reference's error-code table.
 *
 * Exit codes: 0 = in sync, 1 = drift detected (CI failure).
 * Run locally: node .github/scripts/check-api-reference.mjs
 */

import fs from 'fs';
import path from 'path';

const isInGithubScripts = process.cwd().endsWith(path.join('.github', 'scripts'));
const rootDir = isInGithubScripts ? path.resolve(process.cwd(), '..', '..') : process.cwd();

const LIB_PATH = path.join(rootDir, 'contracts', 'proof_registry', 'src', 'lib.rs');
const DOC_PATH = path.join(rootDir, 'docs', 'PROOF_REGISTRY_API.md');

// Entry points implemented in the SDK/private module rather than the main
// `#[contractimpl]` block (e.g. `#[contractclient]` traits) — not part of the
// ProofRegistry ABI, so the reference is not required to document them.
const DOC_SEE_ALSO = new Set();

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exitCode = 1;
}

// ── Parse the contract source ─────────────────────────────────────────────────

const source = fs.readFileSync(LIB_PATH, 'utf8');

// Only scan the `#[contractimpl]` block — stops at the test module (`#[cfg(test)]`)
// so test helpers never count as entrypoints.
const contractimplIdx = source.indexOf('#[contractimpl]');
if (contractimplIdx === -1) {
  fail(`No #[contractimpl] block found in ${LIB_PATH}`);
  process.exit(process.exitCode ?? 1);
}
const testModuleIdx = source.search(/\n#\[cfg\(test\)\]/);
const implBody = source.slice(
  contractimplIdx,
  testModuleIdx === -1 ? source.length : testModuleIdx,
);

const entrypoints = [];
const entryRe = /pub fn (\w+)/g;
let match;
while ((match = entryRe.exec(implBody)) !== null) {
  if (!entrypoints.includes(match[1])) entrypoints.push(match[1]);
}

// Error enum variants: `Name = N,` between `pub enum Error` and its closing brace.
const enumIdx = source.indexOf('pub enum Error');
if (enumIdx === -1) {
  fail(`No Error enum found in ${LIB_PATH}`);
  process.exit(process.exitCode ?? 1);
}
const enumBody = source.slice(enumIdx, source.indexOf('}', enumIdx));
const errors = [];
const errRe = /(\w+)\s*=\s*(\d+)\s*,/g;
while ((match = errRe.exec(enumBody)) !== null) {
  errors.push({ name: match[1], code: Number(match[2]) });
}

// ── Parse the reference doc ───────────────────────────────────────────────────

const doc = fs.readFileSync(DOC_PATH, 'utf8');

const sectionRe = /^### `(\w+)`$/gm;
const docSections = [];
while ((match = sectionRe.exec(doc)) !== null) {
  docSections.push(match[1]);
}

// Split the doc into per-section chunks so required fields are checked within
// the right section (and the error table is only scanned for error presence).
const sectionChunks = [];
for (let i = 0; i < docSections.length; i++) {
  const start = doc.indexOf(`### \`${docSections[i]}\``);
  const end =
    i + 1 < docSections.length
      ? doc.indexOf(`### \`${docSections[i + 1]}\``)
      : doc.length;
  sectionChunks.push({ name: docSections[i], body: doc.slice(start, end) });
}

// ── 1. Every entrypoint must be documented ────────────────────────────────────

const documented = new Set(docSections);
const missing = entrypoints.filter((fn) => !documented.has(fn));

// The constructor is documented as `### \`__constructor\`` under §1; treat it
// like any other entrypoint (its section must carry the same required fields).

for (const fn of missing) {
  fail(
    `docs/PROOF_REGISTRY_API.md is missing a "### \\\`${fn}\\\`" section for the public entrypoint \`${fn}\` (${LIB_PATH}). Update the API reference in the same PR.`,
  );
}

// ── 2. No stale sections ──────────────────────────────────────────────────────

const liveSet = new Set(entrypoints);
for (const name of docSections) {
  if (!liveSet.has(name) && !DOC_SEE_ALSO.has(name)) {
    fail(
      `docs/PROOF_REGISTRY_API.md documents \`${name}\`, which is not a public entrypoint of ${LIB_PATH}. Remove or rename the stale section.`,
    );
  }
}

// ── 3. Required fields per documented entrypoint ──────────────────────────────

const REQUIRED_LABELS = ['**Audience:**', '**Auth:**', '**Panics:**'];
for (const chunk of sectionChunks) {
  if (!liveSet.has(chunk.name)) continue; // stale sections already reported
  for (const label of REQUIRED_LABELS) {
    if (!chunk.body.includes(label)) {
      fail(
        `The "### \\\`${chunk.name}\\\`" section in docs/PROOF_REGISTRY_API.md is missing a "${label}" line.`,
      );
    }
  }
}

// ── 4. Every error variant must appear in the reference ───────────────────────

for (const { name, code } of errors) {
  const nameHits = (doc.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
  const codeHits = (doc.match(new RegExp(`\\b${code}\\b`, 'g')) || []).length;
  if (nameHits < 2 || codeHits < 1) {
    fail(
      `Error variant \`${name} = ${code}\` must appear in docs/PROOF_REGISTRY_API.md (in the §10 error table with both its name and numeric code).`,
    );
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const entryCount = entrypoints.length;
if (process.exitCode) {
  console.error(
    `\nAPI reference drift detected. Expected ${entryCount} entrypoints ` +
      `(found: ${entrypoints.join(', ')}).`,
  );
  process.exit(process.exitCode);
}

console.log(
  `API reference in sync: ${entryCount}/${entryCount} public entrypoints documented ` +
    `(${errors.length} error variants checked).`,
);
console.log('  - ' + entrypoints.join(', '));
