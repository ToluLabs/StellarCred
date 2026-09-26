// Bundles the dedicated prover worker (lib/proof-worker.ts + the lib/proof.ts
// engine it imports) into public/workers/proof-worker.js, served as a plain
// native ES module and started with `new Worker("/workers/proof-worker.js",
// { type: "module" })`.
//
// Why not `new Worker(new URL("./proof-worker.ts", import.meta.url))`?
// That is webpack 5's blessed pattern, and it *does* make Next emit a worker
// chunk group with the right `chunkLoading: "import-scripts"` — but Next's App
// Router runs every module in the app graph through
// `next-flight-client-module-loader`, which rewrites the module into a
// React-Server-Components client reference. The emitted worker chunk ends up
// 8 bytes long (`_N_E={};`) with none of the worker's code in it, so the
// worker boots and silently does nothing. Verified with a chunk-graph dump
// during `next build`:
//
//   chunk id=410 files=["static/chunks/410.<hash>.js"]
//     modules=["next-flight-client-module-loader.js!next-swc-loader.js!…/lib/proof-worker.ts"]
//     group chunkLoading=import-scripts
//
// This is the same class of problem the repo already solves for bb.js (see
// copy-bb.mjs): code that must run as a native browser module is kept out of
// the bundler and served from /public instead.
//
// The TypeScript source stays the single source of truth — this script only
// emits an artifact, exactly like copy-bb.mjs does for @aztec/bb.js. Runs on
// predev/prebuild so the artifact can never drift from the source.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const entry = join(root, "lib", "proof-worker.ts");
const outFile = join(root, "public", "workers", "proof-worker.js");

// esbuild is a devDependency: tsx (used by `pnpm test:theme`) already pulls it
// in, but it is declared explicitly here rather than resolved transitively, so
// this script cannot break because an unrelated dependency changed.
let esbuild;
try {
  esbuild = await import("esbuild");
} catch {
  throw new Error(
    "[build-proof-worker] esbuild is not installed. Run `pnpm install` in frontend/ first.",
  );
}

rmSync(outFile, { force: true });
mkdirSync(dirname(outFile), { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  // /bb/index.js is resolved by the *browser* at runtime against /public/bb
  // (copied there by copy-bb.mjs) and must survive bundling untouched, exactly
  // as the webpackIgnore comment at its call site in lib/proof.ts intends.
  external: ["/bb/index.js"],
  legalComments: "none",
  logLevel: "warning",
});

// ── Guard the artifact ──────────────────────────────────────────────────────
// A silently wrong emit here means proving hangs at runtime rather than
// failing at build time, so assert the two properties the worker depends on.
const bundle = readFileSync(outFile, "utf-8");
const checks = [
  // The worker entry wiring is present (not tree-shaken away).
  [/onmessage/, "worker message wiring"],
  // bb.js is still a runtime dynamic import, not an inlined/rewritten path.
  // (esbuild keeps the `webpackIgnore` comment inside the call, hence [\s\S]*.)
  [/import\([\s\S]{0,120}?["']\/bb\/index\.js["']\s*\)/, "runtime import of /bb/index.js"],
  // The orchestration made it in.
  [/\/api\/witness/, "witness endpoint call"],
];
const missing = checks.filter(([re]) => !re.test(bundle));
if (missing.length > 0) {
  throw new Error(
    `[build-proof-worker] emitted worker is missing: ${missing
      .map(([, label]) => label)
      .join(", ")}`,
  );
}

const kb = (Buffer.byteLength(bundle) / 1024).toFixed(1);
console.log(`[build-proof-worker] bundled prover worker -> public/workers/proof-worker.js (${kb} kB)`);
