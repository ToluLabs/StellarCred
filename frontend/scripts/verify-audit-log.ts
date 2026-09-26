#!/usr/bin/env node
/**
 * Verify the integrity of the hash-chained issuance audit log.
 *
 * Reads the JSON-lines log file written by /api/issue (see lib/audit-log.ts
 * and docs/audit-log.md) and checks that every entry's hash matches its
 * recomputed digest and that each entry chains to the previous entry's hash.
 * Any tampering — a modified commitment, a re-ordered or deleted entry, a
 * rewritten hash — breaks the chain and is reported here.
 *
 * Usage:
 *   pnpm verify:audit-log                 # default file (.data/audit-log.jsonl)
 *   pnpm verify:audit-log -- --file PATH  # explicit log file
 *   AUDIT_LOG_PATH=PATH pnpm verify:audit-log
 *
 * Exit codes: 0 = chain intact, 1 = tampering or an unreadable/invalid file.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAuditLogLines, verifyAuditChain } from "../lib/audit-log";

function usage(): never {
  process.stderr.write(
    "usage: verify-audit-log [--file <path>]\n" +
      "       (or set AUDIT_LOG_PATH; defaults to .data/audit-log.jsonl)\n",
  );
  process.exit(2);
}

function resolvePath(): string {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--file") usage();
    return args[1];
  }
  return (
    process.env.AUDIT_LOG_PATH ??
    path.join(process.cwd(), ".data", "audit-log.jsonl")
  );
}

function main(): void {
  const filePath = resolvePath();

  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
    process.stderr.write(
      `error: cannot read audit log at ${filePath} (${(e as Error).message})\n`,
    );
    process.exit(1);
  }

  let entries;
  try {
    entries = parseAuditLogLines(text);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
  }

  if (entries.length === 0) {
    process.stdout.write(`audit log at ${filePath} is empty (0 entries)\n`);
    process.exit(0);
  }

  const result = verifyAuditChain(entries);
  if (result.valid) {
    process.stdout.write(
      `audit log OK: ${entries.length} entries, chain intact (${filePath})\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    `audit log TAMPERED: ${entries.length} entries, ${result.errors.length} problem(s) (${filePath})\n`,
  );
  for (const err of result.errors) process.stdout.write(`  - ${err}\n`);
  process.exit(1);
}

main();
