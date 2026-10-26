/**
 * backfill-cli.ts — Operator entrypoint for `npm run backfill` (#611).
 *
 *   npm run backfill -- --from 1000000 --to 1200000
 *   npm run backfill -- --from genesis            # START_LEDGER (or earliest) to head
 *   npm run backfill -- --resume                  # continue an interrupted run
 *
 * Runs independently of the live service: it does not start the poll loop or
 * the HTTP API, and it does not move the live cursor.
 */

import "dotenv/config";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { parseBackfillArgs, runBackfill } from "./backfill";

const main = async (): Promise<void> => {
  const opts = parseBackfillArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createDb(config);
  await db.migrate();

  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log("[backfill] Interrupt received; progress is checkpointed. Re-run with --resume to continue.");
    process.exit(130);
  });

  try {
    await runBackfill(config, db, opts);
  } finally {
    await db.close();
  }
};

main().catch((err) => {
  console.error("[backfill] Failed:", (err as Error).message);
  console.error("[backfill] Completed batches are checkpointed; re-run with --resume to continue.");
  process.exit(1);
});
