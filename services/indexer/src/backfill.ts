/**
 * backfill.ts — Operator CLI for bounded historical indexing.
 *
 * Usage:
 *   npm run backfill -- --from <ledger|genesis> [--to <ledger|head>]
 *
 * Examples:
 *   npm run backfill -- --from 100000 --to 120000
 *   npm run backfill -- --from genesis --to head
 *
 * The backfill is fully resumable: if interrupted (Ctrl-C / SIGTERM) the
 * current page cursor is checkpointed to the DB before the process exits.
 * Re-running with the same --from value resumes from that exact cursor.
 * Using a different --from value starts a fresh backfill from the new ledger.
 *
 * Live ingestion is not affected — this CLI never starts the poll loop.
 */

import 'dotenv/config';
import { loadConfig } from './config';
import { createDb } from './db';
import { createIngester, type BackfillProgress } from './ingester';
import type { Db } from './db-types';

export interface BackfillArgs {
  fromLedger: number;
  toLedger?: number;
}

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  let from: string | undefined;
  let to: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from') from = argv[++i];
    else if (arg === '--to') to = argv[++i];
    else if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
    else throw new Error('Unknown argument: ' + arg);
  }

  if (!from) throw new Error("--from is required (use a ledger number or 'genesis')");
  const fromLedger = from.toLowerCase() === 'genesis' ? 1 : Number(from);
  if (!Number.isInteger(fromLedger) || fromLedger < 1) throw new Error('Invalid --from ledger: ' + from);

  let toLedger: number | undefined;
  if (to && to.toLowerCase() !== 'head') {
    toLedger = Number(to);
    if (!Number.isInteger(toLedger) || toLedger < fromLedger) throw new Error('Invalid --to ledger: ' + to);
  }
  return { fromLedger, toLedger };
}

function printUsage(): void {
  console.log(
    'StellarCred indexer — historical backfill\n\n' +
    'Usage:\n' +
    '  npm run backfill -- --from <ledger|genesis> [--to <ledger|head>]\n\n' +
    'Arguments:\n' +
    '  --from  Starting ledger (positive integer) or "genesis" (ledger 1).\n' +
    '  --to    Ending ledger (positive integer) or "head" (current tip). Default: head.\n\n' +
    'Examples:\n' +
    '  npm run backfill -- --from 100000 --to 120000\n' +
    '  npm run backfill -- --from genesis\n' +
    '  npm run backfill -- --from genesis --to head\n\n' +
    'Resumption:\n' +
    '  Interrupt with Ctrl-C at any time. The current page cursor is saved to\n' +
    '  the database so the next run with the same --from resumes exactly where\n' +
    '  it left off. Pass a different --from to start a fresh backfill.\n\n' +
    'Throughput:\n' +
    '  Set BACKFILL_BATCH_SIZE (default 200, max 200) to tune page size.\n' +
    '  ~5 million ledgers ≈ 25 000 pages at limit=200; expect 1–3 hours on\n' +
    '  a standard Horizon testnet deployment.\n',
  );
}

/** Render one progress line to stdout. */
function printProgress(progress: BackfillProgress): void {
  const eta =
    progress.etaSeconds !== null
      ? ` | ETA ${fmtDuration(progress.etaSeconds)}`
      : '';
  const rate =
    progress.ledgersPerSecond > 0
      ? ` | ${progress.ledgersPerSecond} ledgers/s`
      : '';
  process.stdout.write(
    `\r[backfill] ${progress.currentLedger}/${progress.toLedger}` +
    ` (${progress.percent}%)` +
    ` pages=${progress.pagesProcessed}` +
    ` events=${progress.eventsProcessed}` +
    ` elapsed=${fmtDuration(progress.elapsedSeconds)}` +
    rate + eta +
    '   ', // trailing spaces overwrite any longer previous line
  );
}

/** Format seconds as "1h 23m 45s", "2m 05s", or "45s". */
function fmtDuration(totalSec: number): string {
  const s = Math.round(totalSec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return `${m}m ${String(sec).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${h}h ${String(min).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}

async function main(): Promise<void> {
  let db: Db | null = null;

  // ── Graceful interruption ──────────────────────────────────────────────
  // On SIGINT or SIGTERM the backfill() loop will finish its current page
  // (the checkpoint is written at page boundaries), then the finally block
  // below closes the DB cleanly. The operator sees a summary of how far
  // the run got before the interrupt so they can plan the next resume.
  let interrupted = false;

  const onSignal = (signal: string) => {
    if (interrupted) return; // second signal → let Node exit immediately
    interrupted = true;
    process.stdout.write('\n'); // move past the \r progress line
    console.log(`\n[backfill] ${signal} received — finishing current page and checkpointing…`);
    // We do NOT call process.exit() here: the backfill loop will drain its
    // in-flight fetchEventsWithRetry call (at most ~30 s for the timeout),
    // write the checkpoint, and then the main() function's finally block
    // closes the DB before we exit normally. Killing a second time forces
    // an immediate exit which is acceptable (the last checkpoint is safe).
  };

  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  try {
    const args = parseBackfillArgs(process.argv.slice(2));
    const config = loadConfig();
    db = createDb(config);
    await db.migrate();
    const ingester = createIngester(config, db);

    // Surface the interrupt flag to the backfill loop via an AbortController
    // that the onProgress callback checks. Once interrupted we stop requesting
    // new pages; the current page's checkpoint has already been written.
    const abortController = new AbortController();
    const wrappedProgress = (progress: BackfillProgress): void => {
      printProgress(progress);
      if (interrupted) abortController.abort();
    };

    const result = await ingester.backfill(
      args.fromLedger,
      args.toLedger,
      wrappedProgress,
    ).catch((err: unknown) => {
      // AbortError from our own controller means we interrupted cleanly.
      if (err instanceof Error && err.name === 'AbortError') return null;
      throw err;
    });

    process.stdout.write('\n'); // end the \r progress line

    if (!result) {
      // Interrupted — fetch the checkpoint to report where we stopped.
      const resumeLedger = await db.getBackfillLedger();
      console.log(
        `[backfill] interrupted — checkpointed at ledger ${resumeLedger}.\n` +
        `Resume with: npm run backfill -- --from ${args.fromLedger}` +
        (args.toLedger ? ` --to ${args.toLedger}` : ''),
      );
      process.exit(130); // 128 + SIGINT (conventional)
    }

    console.log(
      `[backfill] complete: ledger ${result.fromLedger} → ${result.toLedger}` +
      ` | ${result.eventsProcessed} event(s)` +
      ` | ${result.pagesProcessed} page(s)` +
      ` | ${fmtDuration(result.elapsedSeconds)} elapsed` +
      ` | avg ${result.ledgersPerSecond} ledgers/s`,
    );
  } finally {
    if (db) await db.close();
  }
}

// Only run when invoked directly (not when imported in tests)
if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill] Fatal error:', err);
    process.exit(1);
  });
}
