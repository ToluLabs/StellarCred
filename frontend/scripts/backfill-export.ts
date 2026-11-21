#!/usr/bin/env node
/**
 * Backfill legacy proof-history exports into the versioned export pipeline (#780).
 *
 * Reads a legacy export file produced by lib/export-history.ts — either the
 * unversioned JSON ({ exportedAt, entries }) or the CSV with the
 * claim_type,verified_at,expiry,tx_hash,issuer header — and rewrites it as a
 * schema v1 artifact carrying generation metadata (see lib/export-schema.ts).
 *
 * Every entry is run through the shared safety validator; malformed rows are
 * skipped and reported rather than carried into the new pipeline.
 *
 * Usage:
 *   node --import tsx scripts/backfill-export.ts --input FILE [--output FILE]
 *        [--format json|csv] [--generator NAME] [--dry-run] [--force]
 *
 *   --input PATH     legacy export file to read (required)
 *   --output PATH    artifact to write (default: <input>.v1.json)
 *   --format F       force legacy-json | legacy-csv (default: sniff extension)
 *   --generator NAME producer string stamped into generation metadata
 *   --dry-run        validate and report, but write nothing
 *   --force          allow overwriting an existing --output file
 *
 * Exit codes: 0 = success (or dry-run OK), 1 = input/read/write error or
 * blocked overwrite, 2 = bad usage. A run with skipped entries still exits 0 —
 * the skips are reported, not fatal, so operators can dry-run a whole folder.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  EXPORT_SCHEMA_VERSION,
  LegacyExportError,
  parseLegacyExport,
  planBackfill,
  serializeArtifact,
  type SourceFormat,
} from "../lib/export-schema";

interface CliArgs {
  input: string;
  output: string;
  format?: SourceFormat;
  generator: string;
  dryRun: boolean;
  force: boolean;
}

const DEFAULT_GENERATOR = "backfill-export";

function usage(message?: string): never {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write(
    "usage: backfill-export --input FILE [--output FILE] " +
      "[--format json|csv] [--generator NAME] [--dry-run] [--force]\n"
  );
  process.exit(2);
}

function sniffFormat(input: string): SourceFormat {
  return path.extname(input).toLowerCase() === ".csv" ? "legacy-csv" : "legacy-json";
}

function parseArgs(argv: string[]): CliArgs {
  let input: string | undefined;
  let output: string | undefined;
  let format: SourceFormat | undefined;
  let generator = DEFAULT_GENERATOR;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) usage(`--${arg.slice(2)} requires a value`);
      return value;
    };
    switch (arg) {
      case "--input":
        input = next();
        break;
      case "--output":
        output = next();
        break;
      case "--format": {
        const value = next();
        if (value !== "json" && value !== "csv") {
          usage("--format must be 'json' or 'csv'");
        }
        format = value === "csv" ? "legacy-csv" : "legacy-json";
        break;
      }
      case "--generator":
        generator = next();
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--force":
        force = true;
        break;
      case "--help":
      case "-h":
        usage();
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }

  if (!input) usage("--input is required");
  const resolvedInput = input as string;
  const resolvedOutput = output ?? `${resolvedInput}.v1.json`;
  return {
    input: resolvedInput,
    output: resolvedOutput,
    format: format ?? sniffFormat(resolvedInput),
    generator,
    dryRun,
    force,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dryRun && existsSync(args.output) && !args.force) {
    process.stderr.write(
      `error: refusing to overwrite existing ${args.output} (pass --force)\n`
    );
    process.exit(1);
  }

  let text: string;
  try {
    text = readFileSync(args.input, "utf8");
  } catch (e) {
    process.stderr.write(
      `error: cannot read ${args.input} (${(e as Error).message})\n`
    );
    process.exit(1);
    return;
  }

  let parsed: ReturnType<typeof parseLegacyExport>;
  try {
    parsed = parseLegacyExport(text, args.format ?? "legacy-json");
  } catch (e) {
    if (e instanceof LegacyExportError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(1);
      return;
    }
    throw e;
  }

  const { artifact, report } = planBackfill(parsed.entries, {
    generator: args.generator,
    sourceFormat: args.format ?? "legacy-json",
    sourceExportedAt: parsed.exportedAt,
  });

  const label = args.dryRun ? "DRY-RUN" : "WRITE";
  process.stdout.write(
    `[${label}] schema v${EXPORT_SCHEMA_VERSION} from ${args.format}: ` +
      `${report.inputCount} read, ${report.outputCount} carried` +
      `${report.skipped.length ? `, ${report.skipped.length} skipped` : ""} ` +
      `(${args.input})\n`
  );
  for (const skip of report.skipped) {
    process.stdout.write(`  - entry ${skip.index}: ${skip.reason}\n`);
  }

  if (args.dryRun) {
    process.stdout.write("dry-run: no file written\n");
    process.exit(0);
    return;
  }

  try {
    writeFileSync(args.output, serializeArtifact(artifact), "utf8");
  } catch (e) {
    process.stderr.write(
      `error: cannot write ${args.output} (${(e as Error).message})\n`
    );
    process.exit(1);
    return;
  }
  process.stdout.write(`wrote ${args.output} (${artifact.count} entries)\n`);
}

main();
