#!/usr/bin/env node

/**
 * Contract Error Compatibility and Verification Script (#967).
 *
 * Validates that:
 * 1. Canonical machine-readable error manifest (contracts/error-codes.json) is valid.
 * 2. All Rust smart contract error enums match the manifest exactly (no missing or drifting codes).
 * 3. Client bindings (frontend/packages/*) mirror the canonical error definitions.
 * 4. SDK and frontend error maps match the canonical error manifest.
 * 5. Error codes are sequential, monotonic, unique, and categorized properly.
 * 6. Reference documentation in docs/contract-error-codes.md covers all contracts and codes.
 *
 * Exit code 0 on full compatibility, 1 on any drift.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const MANIFEST_PATH = path.join(rootDir, "contracts", "error-codes.json");
const DOC_PATH = path.join(rootDir, "docs", "contract-error-codes.md");

const CONTRACT_FILES = {
  proof_registry: path.join(rootDir, "contracts", "proof_registry", "src", "lib.rs"),
  issuer_registry: path.join(rootDir, "contracts", "issuer_registry", "src", "lib.rs"),
  credential_verifier: path.join(rootDir, "contracts", "credential_verifier", "src", "lib.rs"),
  gated_pool: path.join(rootDir, "contracts", "gated_pool", "src", "lib.rs"),
};

const CLIENT_FILES = {
  proof_registry: path.join(rootDir, "frontend", "packages", "proof-registry", "src", "index.ts"),
  issuer_registry: path.join(rootDir, "frontend", "packages", "issuer-registry", "src", "index.ts"),
};

const SDK_ERRORS_PATH = path.join(rootDir, "frontend", "packages", "sdk", "src", "errors.ts");
const FRONTEND_ERRORS_PATH = path.join(rootDir, "frontend", "lib", "contract-errors.ts");

const ALLOWED_CATEGORIES = new Set([
  "configuration",
  "validation",
  "authorization",
  "operational",
  "lifecycle",
]);

let failures = 0;

function logError(msg) {
  console.error(`[ERROR] ${msg}`);
  failures++;
}

function logSuccess(msg) {
  console.log(`[OK] ${msg}`);
}

function parseRustErrors(contractName, filePath) {
  if (!fs.existsSync(filePath)) {
    logError(`Contract source not found: ${filePath}`);
    return null;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const enumMatch = content.match(/pub enum Error \{([\s\S]*?)\}/);
  if (!enumMatch) {
    logError(`Could not find 'pub enum Error' in ${filePath}`);
    return null;
  }

  const body = enumMatch[1];
  const lines = body.split("\n");
  const errors = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("///") || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(\d+),?/);
    if (match) {
      const name = match[1];
      const code = parseInt(match[2], 10);
      errors.set(code, name);
    }
  }

  return errors;
}

function parseClientErrors(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const startIdx = content.indexOf("export const Errors = {");
  if (startIdx === -1) {
    return null;
  }

  const braceStart = content.indexOf("{", startIdx);
  let depth = 0;
  let endIdx = -1;
  for (let i = braceStart; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) {
    return null;
  }

  const body = content.substring(braceStart, endIdx + 1);
  const regex = /(\d+)\s*:\s*\{\s*message\s*:\s*"([A-Za-z0-9_]+)"\s*\}/g;
  const errors = new Map();
  let match;
  while ((match = regex.exec(body)) !== null) {
    errors.set(parseInt(match[1], 10), match[2]);
  }

  return errors;
}

function verifyManifestStructure(manifest) {
  if (!manifest || typeof manifest !== "object") {
    logError("Manifest is not a valid JSON object");
    return false;
  }

  if (!manifest.version || !manifest.contracts) {
    logError("Manifest missing required top-level fields (version, contracts)");
    return false;
  }

  for (const [contractKey, contractData] of Object.entries(manifest.contracts)) {
    if (!contractData.name || !contractData.errors) {
      logError(`Contract ${contractKey} missing 'name' or 'errors'`);
      continue;
    }

    const codes = Object.keys(contractData.errors).map((k) => parseInt(k, 10)).sort((a, b) => a - b);
    if (codes.length === 0) {
      logError(`Contract ${contractKey} defines zero errors`);
      continue;
    }

    for (let i = 0; i < codes.length; i++) {
      const expectedCode = i + 1;
      if (codes[i] !== expectedCode) {
        logError(
          `Contract ${contractKey} error codes not sequential: expected ${expectedCode}, got ${codes[i]}`,
        );
      }

      const errObj = contractData.errors[String(codes[i])];
      if (errObj.code !== codes[i]) {
        logError(
          `Contract ${contractKey} error entry key ${codes[i]} does not match err.code ${errObj.code}`,
        );
      }

      if (!errObj.name || typeof errObj.name !== "string") {
        logError(`Contract ${contractKey} error ${codes[i]} missing valid 'name'`);
      }

      if (!ALLOWED_CATEGORIES.has(errObj.category)) {
        logError(
          `Contract ${contractKey} error ${codes[i]} has invalid category: ${errObj.category}`,
        );
      }

      if (typeof errObj.retryable !== "boolean") {
        logError(`Contract ${contractKey} error ${codes[i]} missing boolean 'retryable'`);
      }

      if (!errObj.description || !errObj.retryGuidance) {
        logError(`Contract ${contractKey} error ${codes[i]} missing description or retryGuidance`);
      }
    }
  }

  return true;
}

function verifyContractParity(manifest) {
  for (const [contractKey, filePath] of Object.entries(CONTRACT_FILES)) {
    const manifestContract = manifest.contracts[contractKey];
    if (!manifestContract) {
      logError(`Manifest missing entry for contract: ${contractKey}`);
      continue;
    }

    const rustErrors = parseRustErrors(contractKey, filePath);
    if (!rustErrors) continue;

    const manifestErrors = new Map();
    for (const [codeStr, item] of Object.entries(manifestContract.errors)) {
      manifestErrors.set(parseInt(codeStr, 10), item.name);
    }

    for (const [code, rustName] of rustErrors.entries()) {
      if (!manifestErrors.has(code)) {
        logError(
          `Contract ${contractKey}: Rust error ${rustName} = ${code} is missing from manifest`,
        );
      } else if (manifestErrors.get(code) !== rustName) {
        logError(
          `Contract ${contractKey}: Code ${code} name mismatch. Rust: ${rustName}, Manifest: ${manifestErrors.get(code)}`,
        );
      }
    }

    for (const [code, manifestName] of manifestErrors.entries()) {
      if (!rustErrors.has(code)) {
        logError(
          `Contract ${contractKey}: Manifest error ${manifestName} = ${code} is missing from Rust enum`,
        );
      }
    }

    logSuccess(
      `Contract ${contractKey} matches manifest (${rustErrors.size} error variants verified)`,
    );
  }
}

function verifyClientParity(manifest) {
  for (const [contractKey, filePath] of Object.entries(CLIENT_FILES)) {
    const clientErrors = parseClientErrors(filePath);
    if (!clientErrors) {
      logError(`Failed to parse client errors from ${filePath}`);
      continue;
    }

    const manifestContract = manifest.contracts[contractKey];
    for (const [codeStr, item] of Object.entries(manifestContract.errors)) {
      const code = parseInt(codeStr, 10);
      if (!clientErrors.has(code)) {
        logError(`Client ${contractKey}: Missing error code ${code} (${item.name})`);
      } else if (clientErrors.get(code) !== item.name) {
        logError(
          `Client ${contractKey}: Error ${code} message mismatch. Expected ${item.name}, got ${clientErrors.get(code)}`,
        );
      }
    }
    logSuccess(`Client ${contractKey} matches manifest (${clientErrors.size} errors verified)`);
  }
}

function verifySdkParity(manifest) {
  if (!fs.existsSync(SDK_ERRORS_PATH)) {
    logError(`SDK errors file not found: ${SDK_ERRORS_PATH}`);
    return;
  }

  const sdkContent = fs.readFileSync(SDK_ERRORS_PATH, "utf8");
  const proofRegistryManifest = manifest.contracts.proof_registry;

  for (const [codeStr, item] of Object.entries(proofRegistryManifest.errors)) {
    const code = parseInt(codeStr, 10);
    const codePattern = new RegExp(`\\b${item.name}\\s*:\\s*${code}\\b`);
    if (!codePattern.test(sdkContent)) {
      logError(`SDK ContractErrorCode missing variant ${item.name}: ${code}`);
    }

    const msgPattern = new RegExp(`^\\s*${code}\\s*:`, "m");
    if (!msgPattern.test(sdkContent)) {
      logError(`SDK PROOF_REGISTRY_ERROR_MESSAGES missing code ${code}`);
    }
  }

  if (fs.existsSync(FRONTEND_ERRORS_PATH)) {
    const frontendContent = fs.readFileSync(FRONTEND_ERRORS_PATH, "utf8");
    for (const codeStr of Object.keys(proofRegistryManifest.errors)) {
      const code = parseInt(codeStr, 10);
      const msgPattern = new RegExp(`^\\s*${code}\\s*:`, "m");
      if (!msgPattern.test(frontendContent)) {
        logError(`Frontend PROOF_REGISTRY_ERRORS missing code ${code}`);
      }
    }
  }

  logSuccess("SDK and frontend error mappings match manifest");
}

function verifyDocumentation(manifest) {
  if (!fs.existsSync(DOC_PATH)) {
    logError(`Documentation file not found: ${DOC_PATH}`);
    return;
  }

  const doc = fs.readFileSync(DOC_PATH, "utf8");

  for (const [contractKey, contractData] of Object.entries(manifest.contracts)) {
    if (!doc.includes(contractData.name)) {
      logError(`Documentation docs/contract-error-codes.md missing reference to ${contractData.name}`);
    }

    for (const [codeStr, item] of Object.entries(contractData.errors)) {
      if (!doc.includes(item.name)) {
        logError(
          `Documentation missing error name ${item.name} for contract ${contractData.name}`,
        );
      }
      if (!doc.includes(`| ${codeStr} |`)) {
        logError(
          `Documentation missing error code ${codeStr} row for contract ${contractData.name}`,
        );
      }
    }
  }

  logSuccess("Documentation in docs/contract-error-codes.md is complete and in sync");
}

function main() {
  console.log("=== StellarCred Contract Error Compatibility Verification ===");

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`Manifest file not found: ${MANIFEST_PATH}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    console.error(`Failed to parse manifest JSON: ${err.message}`);
    process.exit(1);
  }

  verifyManifestStructure(manifest);
  verifyContractParity(manifest);
  verifyClientParity(manifest);
  verifySdkParity(manifest);
  verifyDocumentation(manifest);

  if (failures > 0) {
    console.error(`\nFAILED: Found ${failures} error compatibility violation(s).`);
    process.exit(1);
  }

  console.log("\nSUCCESS: All contract error codes, client packages, and docs are compatible and in sync.");
}

main();
