/**
 * index.ts — Entrypoint.
 *
 * Wires together config → DB → ingester → HTTP API.
 * Order of operations:
 *   1. Load config (validates required env vars early).
 *   2. Create and migrate the database.
 *   3. Start the event ingester (background polling loop).
 *   4. Start the HTTP server.
 *   5. On SIGINT / SIGTERM: stop ingester, close DB, exit cleanly.
 */

import "dotenv/config";
import http from "http";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { createIngester } from "./ingester";
import { createIntegrityChecker } from "./integrity";
import { buildApp } from "./api";
import { logger } from "./logging";

async function main(): Promise<void> {
  const config = loadConfig();

  // ── Database ────────────────────────────────────────────────────────────
  const db = createDb(config);
  await db.migrate();
  logger.info("indexer_database_ready", { db_driver: config.dbDriver });

  // ── Ingester ────────────────────────────────────────────────────────────
  const ingester = createIngester(config, db);
  ingester.start();

  // ── On-chain data-integrity checks (#612) ────────────────────────────────
  // Periodically re-reads a rotating sample of claims out of contract state so
  // drift in the event-derived table surfaces as a metric instead of silently
  // wrong answers for consumers.
  const integrity = createIntegrityChecker(config, db);
  integrity.start();

  // ── HTTP API ──────────────────────────────────────────────────────────────
  const app = buildApp(db, ingester, config, integrity);
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, () => resolve());
    server.once("error", reject);
  });
  logger.info("indexer_listening", { port: config.port });

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    logger.info("indexer_shutting_down");
    ingester.stop();
    await ingester.shutdown();
    await integrity.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    logger.info("indexer_stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  logger.error("indexer_startup_failed", { error: err });
  process.exit(1);
});