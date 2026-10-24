// ESLint flat config for the indexer service (#855).
//
// This replaces the .eslintrc.json that shipped with the service's first
// commit. ESLint was never added to devDependencies and no `lint` script ever
// existed (although `npm run check` called one), so those rules were never
// executed and could not be trusted. Flat-config form is deliberate: ESLint 9,
// the major the frontend workspace pins, does not read .eslintrc.* files.
//
// The rule set mirrors the contract in frontend/eslint.config.mjs, narrowed for
// a Node service — no React or Next.js presets, and no browser globals.
// Severity follows the monorepo convention from #855: `error` blocks CI, and a
// `warn` must carry a reason and a follow-up. Only one rule is downgraded here:
//
//   @typescript-eslint/no-explicit-any — 7 pre-existing uses (XDR/SDK values
//   crossing an untyped boundary, all in api.ts / api.test.ts / graphql.ts
//   resolvers). Tightening those types is a typing task, not a linting one, so
//   they are surfaced as warnings and new code is expected to avoid them.
//
// The inline `// eslint-disable-next-line` notes already in src/ (lazy `require`
// of optional drivers in db-postgres.ts / db-sqlite.ts / ingester.ts, and the
// unused parameter in api.ts) are what those suppressions were written for and
// are honoured by this config.
//
// No `globals` entry is needed for `process`, `describe`, `it`, `expect` etc.:
// typescript-eslint's recommended set turns off core `no-undef` for TypeScript
// files, where the compiler is the authority on identifier existence.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // dist/ is `tsc` output; anything else generated lives outside src/.
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
);
