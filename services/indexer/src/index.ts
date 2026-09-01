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
import { buildApp } from "./api";

async function main(): Promise<void> {
  const config = loadConfig();

  // ── Database ────────────────────────────────────────────────────────────
  const db = createDb(config);
  await db.migrate();
  console.log(`[indexer] Database ready (driver: ${config.dbDriver})`);

  // ── Ingester ────────────────────────────────────────────────────────────
  const ingester = createIngester(config, db);
  ingester.start();

  // ── HTTP API ──────────────────────────────────────────────────────────────
  const app = buildApp(db, ingester, config);
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.listen(config.port, () => resolve());
    server.once("error", reject);
  });
  console.log(`[indexer] HTTP API listening on :${config.port}`);

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    console.log("[indexer] Shutting down…");
    ingester.stop();
    await ingester.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    console.log("[indexer] Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[indexer] Fatal startup error:", err);
  process.exit(1);
});