/**
 * assert-no-issuer-secrets-in-bundle.mjs
 *
 * Scans frontend client source modules and build assets to verify that no
 * server-only issuer secrets, private keys, or forbidden NEXT_PUBLIC_ variables
 * have leaked into client code (#976).
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const frontendDir = resolve(__dirname, "..");

const FORBIDDEN_SECRET_PATTERNS = [
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  /NEXT_PUBLIC_ISSUER_PRIVATE_KEY/,
  /NEXT_PUBLIC_ADMIN_API_KEY/,
  /NEXT_PUBLIC_JWT_SECRET/,
  /NEXT_PUBLIC_DATABASE_URL/,
  /process\.env\.ISSUER_PRIVATE_KEY/,
];

// Directories containing client-executed or client-accessible code
const CLIENT_SCAN_DIRS = [
  resolve(frontendDir, "app"),
  resolve(frontendDir, "components"),
  resolve(frontendDir, "public"),
];

let violations = [];

function scanFile(filePath) {
  // Exclude API routes (which are server-only)
  if (filePath.includes(`${resolve(frontendDir, "app/api")}`)) {
    return;
  }

  const ext = extname(filePath);
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"].includes(ext)) {
    return;
  }

  const content = readFileSync(filePath, "utf8");
  for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
    if (pattern.test(content)) {
      violations.push({ filePath, pattern: pattern.toString() });
    }
  }
}

function walkDir(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkDir(fullPath);
    } else {
      scanFile(fullPath);
    }
  }
}

console.log("Scanning client directories for issuer secrets and forbidden environment variables...");
for (const dir of CLIENT_SCAN_DIRS) {
  walkDir(dir);
}

if (violations.length > 0) {
  console.error(`[FAIL] Found ${violations.length} secret boundary violation(s):`);
  for (const v of violations) {
    console.error(`  - ${v.filePath} matches ${v.pattern}`);
  }
  process.exit(1);
} else {
  console.log("[PASS] Zero issuer secrets or forbidden NEXT_PUBLIC_ variables found in client code.");
}
