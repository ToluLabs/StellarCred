import { z } from "zod";

// Server-only module. lib/stellar.ts and any "use client" page that reads a
// NEXT_PUBLIC_ var must keep doing so via a literal `process.env.NEXT_PUBLIC_X`
// expression — that's the only form Next.js's build-time inliner recognizes.
// Reading the same value off the `env` object below would work on the server
// but silently resolve to `undefined` in the browser bundle. This module is
// for server-only consumers (API route handlers, instrumentation.ts).
if (typeof window !== "undefined") {
  throw new Error("lib/env.ts is server-only and must not be imported from client code.");
}

// .env files and process.env represent "unset" as either a missing key or an
// empty string (e.g. a blank `FOO=` line in .env.local). Treat both the same
// way so shipping .env.example with blank optional keys never trips required
// checks or format validators on keys the user hasn't filled in yet.
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const STELLAR_G_ADDRESS = /^G[A-Z2-7]{55}$/;

// Server-only secrets that must never be readable from the browser. If any of
// these is ever set with a NEXT_PUBLIC_ prefix (typo or copy/paste mistake),
// Next.js would inline it into the client bundle at build time.
const SERVER_SECRET_KEYS = [
  "ISSUER_PRIVATE_KEY",
  "PERSONA_API_KEY",
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "PLAID_ACCESS_TOKEN",
] as const;

const envSchema = z
  .object({
    // --- Stellar network ---------------------------------------------------
    NEXT_PUBLIC_STELLAR_NETWORK: z
      .enum(["testnet", "mainnet", "futurenet", "standalone"])
      .default("testnet"),
    NEXT_PUBLIC_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
    NEXT_PUBLIC_NETWORK_PASSPHRASE: z
      .string()
      .min(1)
      .default("Test SDF Network ; September 2015"),

    // --- Issuer --------------------------------------------------------------
    // Registered issuer's Stellar address. Optional: unset only disables the
    // demo pre-selection in the /issuer dropdown, everything else keeps working.
    NEXT_PUBLIC_ISSUER_ADDRESS: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(STELLAR_G_ADDRESS, "must be a 56-character Stellar address starting with G")
        .optional(),
    ),
    // Optional JSON map of issuer address -> display name, e.g. {"G...":"Bank"}.
    NEXT_PUBLIC_ISSUER_NAMES: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .refine(
          (v) => {
            try {
              const parsed = JSON.parse(v);
              return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
            } catch {
              return false;
            }
          },
          { message: 'must be a JSON object string, e.g. {"G...":"Partner Bank"}' },
        )
        .optional(),
    ),
    // No schema default: app/api/issue/route.ts falls back to the incoming
    // request's own origin when this is unset (correct per-request behavior
    // for local dev Persona redirects), and the SDK applies its own default.
    NEXT_PUBLIC_STELLARCRED_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

    // --- Indexer service -------------------------------------------------------
    // Base URL of services/indexer's HTTP API. Server-only: only
    // app/api/issuer-stats/route.ts reads it, so it never needs a
    // NEXT_PUBLIC_ prefix. Defaults to the indexer's own default PORT (3001).
    INDEXER_URL: z.preprocess(
      emptyToUndefined,
      z.string().url().optional(),
    ),

    // Server-only issuer signing key. Optional: absence runs the public demo
    // issuer key (logged loudly on every boot) instead of a real one.
    ISSUER_PRIVATE_KEY: z.preprocess(
      emptyToUndefined,
      z.string().regex(HEX_64, "must be a 64-character hex secp256k1 private key").optional(),
    ),

    // --- Deployed contract IDs (scripts/deploy.sh output) ---------------------
    NEXT_PUBLIC_ISSUER_REGISTRY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    NEXT_PUBLIC_PROOF_REGISTRY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    NEXT_PUBLIC_GATED_POOL_ID: z.preprocess(emptyToUndefined, z.string().optional()),

    // --- Persona identity verification (optional; unset = demo mode) ---------
    PERSONA_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    PERSONA_KYC_TEMPLATE_ID: z.preprocess(emptyToUndefined, z.string().optional()),

    // --- Plaid balance attestation (optional; unset = mock mode) --------------
    PLAID_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    PLAID_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
    PLAID_ACCESS_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
    PLAID_ENV: z.enum(["sandbox", "development", "production"]).default("sandbox"),

    // --- Rate limiting --------------------------------------------------------
    // All limits are optional; unset = built-in defaults (see lib/rate-limit.ts).
    // RATE_LIMIT_WINDOW_SECONDS applies to every route; the per-route vars set
    // the maximum request count within that window.
    //
    // Single-instance deployments (PM2, Docker, Railway): in-memory store is
    // fully effective — set these to taste.
    //
    // Serverless / multi-replica deployments (Vercel, AWS Lambda, etc.): the
    // in-memory store is per-isolate, so limits are not enforced across cold
    // starts or concurrent instances. Replace lib/rate-limit.ts's `checkLimit`
    // with a shared atomic store (Upstash Redis / Vercel KV) for those targets.
    RATE_LIMIT_WINDOW_SECONDS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    RATE_LIMIT_ISSUE_IP: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    RATE_LIMIT_ISSUE_WALLET: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    RATE_LIMIT_WITNESS_IP: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    RATE_LIMIT_PLAID_IP: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),

    // --- Ops -------------------------------------------------------------------
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    APP_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()),
    ERROR_REPORTING_WEBHOOK: z.preprocess(emptyToUndefined, z.string().url().optional()),
  })
  .superRefine((val, ctx) => {
    // The /api/issue route previously discovered this combination missing at
    // request time (a 500 mid-flow); catching it at startup surfaces the same
    // misconfiguration before the app accepts any traffic.
    if (val.PERSONA_API_KEY && !val.PERSONA_KYC_TEMPLATE_ID) {
      ctx.addIssue({
        code: "custom",
        path: ["PERSONA_KYC_TEMPLATE_ID"],
        message: "required when PERSONA_API_KEY is set (government-ID KYC template)",
      });
    }

    // Plaid's balance API needs client_id + secret + access_token together;
    // the old code sent whichever were set and let Plaid's API reject the
    // request with a cryptic error if one was missing.
    const plaid = {
      PLAID_CLIENT_ID: val.PLAID_CLIENT_ID,
      PLAID_SECRET: val.PLAID_SECRET,
      PLAID_ACCESS_TOKEN: val.PLAID_ACCESS_TOKEN,
    };
    const setCount = Object.values(plaid).filter(Boolean).length;
    if (setCount > 0 && setCount < 3) {
      for (const [key, value] of Object.entries(plaid)) {
        if (!value) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message:
              "PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ACCESS_TOKEN must all be set together once any one of them is set",
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(details: string[]) {
    super(
      [
        "Invalid environment configuration:",
        ...details.map((d) => `  - ${d}`),
        "",
        "See frontend/.env.example for the full list of required and optional keys.",
      ].join("\n"),
    );
    this.name = "EnvValidationError";
  }
}

function findLeakedServerSecrets(raw: Record<string, string | undefined>): string[] {
  return SERVER_SECRET_KEYS.filter((key) => !!raw[`NEXT_PUBLIC_${key}`]).map(
    (key) => `NEXT_PUBLIC_${key}`,
  );
}

/**
 * Validates raw process.env against the schema above. Exported (rather than
 * only run at module scope) so it can be exercised directly in tests with
 * arbitrary env fixtures, without needing to mutate the real process.env.
 */
export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  // Checked before the Zod parse: this is a distinct class of mistake (a
  // secret in the wrong variable name) from "missing or malformed", and
  // deserves its own unambiguous error rather than being folded into schema
  // issues for an unrecognized key.
  const leaked = findLeakedServerSecrets(raw);
  if (leaked.length > 0) {
    throw new EnvValidationError(
      leaked.map(
        (key) =>
          `${key} is set — server secrets must never carry a NEXT_PUBLIC_ prefix, or Next.js will inline them into the client bundle. Remove the prefix and keep this server-only.`,
      ),
    );
  }

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new EnvValidationError(details);
  }

  return parsed.data;
}

// Validated once, at import time. Importing this module — directly, or via
// instrumentation.ts's register() at server boot — is what makes validation
// happen "on startup" rather than lazily on first use of a given key.
export const env: Env = loadEnv();