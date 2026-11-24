/**
 * backfill-cli.ts — Operator entrypoint for `npm run backfill` (#611, #1000).
 *
 *   npm run backfill -- --from 1000000 --to 1200000
 *   npm run backfill -- --from genesis            # START_LEDGER (or earliest) to head
 *   npm run backfill -- --resume                  # continue an interrupted run
 *   npm run backfill -- --from 1000000 --force    # replace or rewind an existing projection
 *
 * Runs independently of the live service: it does not start the poll loop or
 * the HTTP API, and it does not move the live cursor.
 */

import "dotenv/config";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { parseBackfillArgs, runBackfill } from "./backfill";
import { logger } from "./logging";

const main = async (): Promise<void> => {
  const opts = parseBackfillArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createDb(config);
  await db.migrate();

  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    logger.info("backfill_interrupted", {
      detail: "progress is checkpointed; re-run with --resume to continue",
    });
    process.exit(130);
  });

  try {
    await runBackfill(config, db, opts);
  } finally {
    await db.close();
  }
};

main().catch((err) => {
  logger.error("backfill_failed", { error: err });
  logger.info("backfill_resume_hint", {
    detail: "completed batches are checkpointed; re-run with --resume to continue",
  });
  process.exit(1);
});
