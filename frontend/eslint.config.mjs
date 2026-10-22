import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Flat-config replacement for the legacy .eslintrc.json that used to back
// `next lint`. Next.js 16 removed `next lint`, so the `lint` script now runs
// the ESLint CLI directly over the app sources (app, components, lib, i18n).
// Rule overrides below mirror the previous .eslintrc.json contract:
//   - react-hooks/exhaustive-deps stays an error,
//   - @typescript-eslint/no-explicit-any stays a warning,
//   - unused-vars keeps the ^_ escape hatch,
//   - prefer-const stays a warning.
//
// react-hooks/set-state-in-effect and react-hooks/refs are new rule-ids from
// the react-hooks v7 plugin that eslint-config-next@16 bundles. They fire on
// 34 pre-existing, working patterns across the app (guarded setState in
// effects, ref-mirroring callbacks); refactoring those is unrelated product
// churn for a framework-upgrade PR, so they are surfaced as warnings now and
// tracked for a dedicated follow-up.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "prefer-const": "warn",
    },
  },
  globalIgnores([
    // Default ignores of eslint-config-next (re-declared because globalIgnores
    // replaces them when overridden):
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Previous .eslintrc.json ignorePatterns equivalents:
    "node_modules/**",
    "public/**",
    "*.config.*",
  ]),
]);

export default eslintConfig;
