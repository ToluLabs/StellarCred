import { readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join, relative } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const out = join(root, "BUNDLE_COMPOSITION.md");

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const rows = files(dist)
  .filter((file) => /\.(mjs|js|d\.ts)$/.test(file))
  .map((file) => ({
    file: relative(root, file).replaceAll("\\", "/"),
    bytes: statSync(file).size,
  }))
  .sort((a, b) => b.bytes - a.bytes);

const total = rows.reduce((sum, row) => sum + row.bytes, 0);
const markdown = [
  "# SDK Bundle Composition",
  "",
  `Generated from ${basename(dist)} after \`pnpm build\`.`,
  "",
  `Total tracked output: ${total} bytes.`,
  "",
  "| File | Bytes | Share |",
  "|---|---:|---:|",
  ...rows.map((row) => {
    const share = total === 0 ? "0.0%" : `${((row.bytes / total) * 100).toFixed(1)}%`;
    return `| \`${row.file}\` | ${row.bytes} | ${share} |`;
  }),
  "",
].join("\n");

writeFileSync(out, markdown);
console.log(`Wrote ${out}`);
