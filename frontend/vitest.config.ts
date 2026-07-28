import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["**/node_modules/**", "**/packages/**"],
    env: {
      // Module-scope constants (e.g. app/verify/page.tsx's DEMO_ISSUER_ID) read
      // this at import time, before any test file body runs — must be set here.
      NEXT_PUBLIC_ISSUER_ADDRESS: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2",
    },
  },
});
