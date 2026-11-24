/**
 * Pre-deploy Environment Variable Validation Script
 *
 * Validates deployment pipeline environment variables before staging/production
 * builds and contract deployments. Detects missing required variables, malformed
 * values, and legacy/typo variable names (e.g., NEXT_PUBLIC_CONTRACT_ID).
 *
 * Usage:
 *   node scripts/validate-deploy-env.mjs [--target=staging|preview|contracts|production]
 *   node scripts/validate-deploy-env.mjs --smoke-test
 */

const NP = "NEXT_PUBLIC";

export const DEPRECATED_TYPO_VARS = {
  [`${NP}_CONTRACT_ID`]:
    "NEXT_PUBLIC_CONTRACT_ID is invalid and deprecated. Use NEXT_PUBLIC_PROOF_REGISTRY_ID, NEXT_PUBLIC_ISSUER_REGISTRY_ID, NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID, and NEXT_PUBLIC_GATED_POOL_ID instead.",
  CONTRACT_ID:
    "CONTRACT_ID is ambiguous and deprecated. Use PROOF_REGISTRY_CONTRACT_ID or NEXT_PUBLIC_PROOF_REGISTRY_ID.",
  STELLAR_NETWORK_NAME:
    "STELLAR_NETWORK_NAME is invalid. Use NEXT_PUBLIC_STELLAR_NETWORK (testnet | mainnet | futurenet | standalone).",
};

export const VALID_NETWORKS = new Set(["testnet", "mainnet", "futurenet", "standalone"]);
const STELLAR_CONTRACT_OR_KEY = /^C[A-Z2-7]{55}$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * Validates a dictionary of environment variables against deploy requirements.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ target?: string; requireVercelSecrets?: boolean }} options
 * @returns {{ valid: boolean; errors: string[]; warnings: string[] }}
 */
export function validateDeployEnv(env = process.env, options = {}) {
  const target = options.target || "staging";
  const errors = [];
  const warnings = [];

  // 1. Check for known typos or deprecated variables
  for (const [typoVar, guidance] of Object.entries(DEPRECATED_TYPO_VARS)) {
    if (env[typoVar] && env[typoVar].trim() !== "") {
      errors.push(`Invalid environment variable '${typoVar}' detected: ${guidance}`);
    }
  }

  // 2. Validate contract deployments
  if (target === "contracts") {
    if (!env.ISSUER_PRIVATE_KEY || env.ISSUER_PRIVATE_KEY.trim() === "") {
      errors.push("Missing required environment variable 'ISSUER_PRIVATE_KEY' for contract deployment.");
    } else if (!HEX_64.test(env.ISSUER_PRIVATE_KEY.trim())) {
      errors.push("ISSUER_PRIVATE_KEY must be a 64-character hexadecimal secp256k1 private key.");
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // 3. Validate frontend staging / preview / production deployments
  const network = env.NEXT_PUBLIC_STELLAR_NETWORK || "testnet";
  if (!VALID_NETWORKS.has(network)) {
    errors.push(
      `Invalid NEXT_PUBLIC_STELLAR_NETWORK: '${network}'. Expected one of: ${[...VALID_NETWORKS].join(", ")}`,
    );
  }

  // Staging/Preview contract IDs validation
  const proofRegistryId =
    env.NEXT_PUBLIC_PROOF_REGISTRY_ID ||
    env.NEXT_PUBLIC_PROOF_REGISTRY_CONTRACT_ID ||
    env.PROOF_REGISTRY_CONTRACT_ID;

  if (!proofRegistryId || proofRegistryId.trim() === "") {
    errors.push(
      "Missing required contract variable: NEXT_PUBLIC_PROOF_REGISTRY_ID must be defined for frontend deployment.",
    );
  } else if (!STELLAR_CONTRACT_OR_KEY.test(proofRegistryId.trim())) {
    warnings.push(
      `NEXT_PUBLIC_PROOF_REGISTRY_ID ('${proofRegistryId}') does not match expected 56-character Soroban contract format (C...).`,
    );
  }

  // Validate Vercel secrets if required
  if (options.requireVercelSecrets) {
    for (const vercelVar of ["VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "VERCEL_TOKEN"]) {
      if (!env[vercelVar] || env[vercelVar].trim() === "") {
        errors.push(`Missing required Vercel credential: '${vercelVar}' is required for deployment.`);
      }
    }
  }

  // Check for leaked server secrets into NEXT_PUBLIC_
  const serverSecrets = [
    "ISSUER_PRIVATE_KEY",
    "PERSONA_API_KEY",
    "PERSONA_WEBHOOK_SECRET",
    "PLAID_CLIENT_ID",
    "PLAID_SECRET",
    "PLAID_ACCESS_TOKEN",
  ];
  for (const secret of serverSecrets) {
    if (env[`NEXT_PUBLIC_${secret}`]) {
      errors.push(
        `Critical Security Leak: NEXT_PUBLIC_${secret} is defined. Server secrets must never carry a NEXT_PUBLIC_ prefix.`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Runs smoke test suite to guarantee validator catches errors and permits valid configurations.
 */
export function runSmokeTest() {
  console.log("Running deploy environment smoke tests...\n");

  // Test 1: Catches NEXT_PUBLIC_CONTRACT_ID typo
  const typoResult = validateDeployEnv({
    [`${NP}_CONTRACT_ID`]: "CB2R3O43TX3G3N3X4Y5Z6A7B8C9D0E1F2G3H4I5J6K7L8M9N0O",
    NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
  });
  if (typoResult.valid || !typoResult.errors.some((e) => e.includes("NEXT_PUBLIC_CONTRACT_ID"))) {
    throw new Error("Smoke test failed: did not catch NEXT_PUBLIC_CONTRACT_ID typo.");
  }
  console.log("✓ Correctly rejected deprecated NEXT_PUBLIC_CONTRACT_ID typo");

  // Test 2: Catches missing NEXT_PUBLIC_PROOF_REGISTRY_ID
  const missingResult = validateDeployEnv({
    NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
  });
  if (missingResult.valid || !missingResult.errors.some((e) => e.includes("NEXT_PUBLIC_PROOF_REGISTRY_ID"))) {
    throw new Error("Smoke test failed: did not catch missing NEXT_PUBLIC_PROOF_REGISTRY_ID.");
  }
  console.log("✓ Correctly rejected missing NEXT_PUBLIC_PROOF_REGISTRY_ID");

  // Test 3: Rejects invalid network
  const badNetworkResult = validateDeployEnv({
    NEXT_PUBLIC_STELLAR_NETWORK: "invalid-net",
    NEXT_PUBLIC_PROOF_REGISTRY_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  if (badNetworkResult.valid || !badNetworkResult.errors.some((e) => e.includes("Invalid NEXT_PUBLIC_STELLAR_NETWORK"))) {
    throw new Error("Smoke test failed: did not catch invalid network.");
  }
  console.log("✓ Correctly rejected invalid network name");

  // Test 4: Rejects secret key leakage
  const leakResult = validateDeployEnv({
    NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
    NEXT_PUBLIC_PROOF_REGISTRY_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    [`${NP}_ISSUER_PRIVATE_KEY`]: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  if (leakResult.valid || !leakResult.errors.some((e) => e.includes("Critical Security Leak"))) {
    throw new Error("Smoke test failed: did not catch NEXT_PUBLIC_ISSUER_PRIVATE_KEY leakage.");
  }
  console.log("✓ Correctly rejected secret key with NEXT_PUBLIC_ prefix");

  // Test 5: Rejects missing ISSUER_PRIVATE_KEY for contracts target
  const contractsMissing = validateDeployEnv({}, { target: "contracts" });
  if (contractsMissing.valid || !contractsMissing.errors.some((e) => e.includes("ISSUER_PRIVATE_KEY"))) {
    throw new Error("Smoke test failed: did not catch missing ISSUER_PRIVATE_KEY for contracts.");
  }
  console.log("✓ Correctly rejected contracts target without ISSUER_PRIVATE_KEY");

  // Test 6: Accepts valid staging configuration
  const validStaging = validateDeployEnv({
    NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
    NEXT_PUBLIC_PROOF_REGISTRY_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    NEXT_PUBLIC_ISSUER_REGISTRY_ID: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    NEXT_PUBLIC_GATED_POOL_ID: "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  });
  if (!validStaging.valid) {
    throw new Error(`Smoke test failed: valid staging config was rejected: ${validStaging.errors.join(", ")}`);
  }
  console.log("✓ Correctly approved valid staging environment configuration\n");
  console.log("All deploy environment validation smoke tests PASSED.");
}

import { fileURLToPath } from "node:url";

// CLI execution only when run directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const args = process.argv.slice(2);
  const isSmokeTest = args.includes("--smoke-test");
  const targetArg = args.find((a) => a.startsWith("--target="));
  const target = targetArg ? targetArg.split("=")[1] : "staging";
  const requireVercel = args.includes("--require-vercel");

  if (isSmokeTest) {
    try {
      runSmokeTest();
      process.exit(0);
    } catch (err) {
      console.error(`Smoke test failure: ${err.message}`);
      process.exit(1);
    }
  } else {
    const result = validateDeployEnv(process.env, { target, requireVercelSecrets: requireVercel });

    if (result.warnings.length > 0) {
      console.warn("⚠️  Deploy Environment Warnings:");
      for (const warning of result.warnings) {
        console.warn(`  - ${warning}`);
      }
    }

    if (!result.valid) {
      console.error("❌ Deploy Environment Validation FAILED:");
      for (const error of result.errors) {
        console.error(`  - ${error}`);
      }
      console.error("\nPlease configure the correct environment variables before proceeding with deployment.");
      process.exit(1);
    }

    console.log("✅ Deploy environment validation successful.");
  }
}

