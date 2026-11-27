import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const budgets = [
  { file: "dist/index.mjs", maxBytes: 80_000 },
  { file: "dist/server.mjs", maxBytes: 80_000 },
];
const sharedChunkMaxBytes = 160_000;

let failed = false;
for (const budget of budgets) {
  const path = join(root, budget.file);
  const bytes = statSync(path).size;
  const status = bytes <= budget.maxBytes ? "ok" : "over";
  console.log(`${status} ${budget.file}: ${bytes} bytes / ${budget.maxBytes} bytes`);
  if (bytes > budget.maxBytes) failed = true;
}

for (const name of readdirSync(join(root, "dist")).filter(
  (file) => file.endsWith(".mjs") && file !== "index.mjs" && file !== "server.mjs",
)) {
  const file = `dist/${name}`;
  const bytes = statSync(join(root, file)).size;
  const status = bytes <= sharedChunkMaxBytes ? "ok" : "over";
  console.log(`${status} ${file}: ${bytes} bytes / ${sharedChunkMaxBytes} bytes`);
  if (bytes > sharedChunkMaxBytes) failed = true;
}

if (failed) {
  process.exitCode = 1;
}
