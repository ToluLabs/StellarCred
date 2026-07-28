// Copies the compiled commit circuit (Poseidon2::hash([value, salt], 2)) from
// the app's public/circuits/ output into src/ so tsup/esbuild can inline it
// directly into dist/index.{js,mjs} — the published package ships fully
// self-contained, with no dependency on this repo's file layout.
//
// The circuit itself is compiled from circuits/commit/src/main.nr via
// circuits/scripts/build.sh; this script only copies the already-built
// artifact, it doesn't compile Noir.
//
// Runs automatically on prebuild so the copy can never drift from the
// currently-built circuit.

import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "..", "public", "circuits", "commit.json");
const dest = join(here, "..", "src", "commit-circuit.json");

copyFileSync(src, dest);
console.log(`[sync-circuit] copied ${src} -> ${dest}`);
