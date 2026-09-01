import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  // Vite's dev-server treatment of /public (serving its files as static
  // assets, and refusing to import JS/CSS from inside it as modules) has no
  // equivalent purpose under vitest -- nothing here is served over HTTP. Left
  // enabled, lib/proof.ts's runtime-only `import("/bb/index.js")` (which
  // exists purely for the *browser* to resolve against /public/bb, see the
  // comments in lib/proof.ts) trips that "cannot import non-asset file"
  // guard before the alias below even gets a chance to redirect it.
  publicDir: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Next.js resolves this via tsconfig.json's own "paths" entry; vitest
      // doesn't read tsconfig paths automatically, so it needs the same
      // mapping mirrored here (#386's presets.ts is the first lib module to
      // import @stellarcred/sdk from outside the sdk package's own tests).
      "@stellarcred/sdk": path.resolve(__dirname, "packages/sdk/index.ts"),
      // lib/proof.ts loads bb.js at runtime via a native, non-bundled
      // `import("/bb/index.js")` (see the comments there) that only the
      // browser ever resolves, against /public/bb/index.js. Vite refuses to
      // import files under /public as JS modules, so route the specifier to
      // a stub here purely so it resolves under vitest; proof.test.ts mocks
      // over this alias target with vi.mock("/bb/index.js", ...).
      "/bb/index.js": path.resolve(__dirname, "lib/__mocks__/bb-index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    exclude: [
      "**/node_modules/**",
      // Node's built-in test runner (pnpm test:theme), not a Vitest suite.
      "lib/theme.test.ts",
    ],
    include: [
      "lib/**/*.test.{js,ts}",
      "packages/sdk/src/**/*.test.{js,ts}",
      "app/**/*.test.{js,ts}",
      "components/**/*.test.{js,ts,tsx}",
    ],
    testTimeout: 30000,
    env: {
      // Module-scope constants (e.g. app/verify/page.tsx's DEMO_ISSUER_ID) read
      // this at import time, before any test file body runs — must be set here.
      NEXT_PUBLIC_ISSUER_ADDRESS: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2",
    },
  },
});
