#!/usr/bin/env node
/**
 * Checks that every process.env / NEXT_PUBLIC_ variable referenced in the
 * codebase is documented in the appropriate .env.example file.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = join(fileURLToPath(import.meta.url), "..", "..");
const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));

const SYSTEM_ENV_VARS = new Set(["NODE_ENV", "NEXT_RUNTIME", "DEBUG"]);

const EXCLUDE_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".git", "public/bb"]);
const EXCLUDE_FILE_PATTERNS = [/\.test\.(ts|tsx|js|mjs|jsx)$/, /\.spec\.(ts|tsx|js|mjs|jsx)$/];

function stripComments(line) {
  return line.replace(/\r?$/, "").replace(/(^|[^:])\/\/.*$/g, '$1');
}

function collectFiles(dir, extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".jsx"])) {
  const files = [];
  function walk(currentDir) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relPath = relative(ROOT_DIR, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        const shouldSkip = [...EXCLUDE_DIRS].some(e => relPath === e || relPath.startsWith(e + "/"));
        if (!shouldSkip) walk(fullPath);
        continue;
      }
      if (basename(fullPath) === SCRIPT_NAME) continue;
      if (EXCLUDE_FILE_PATTERNS.some(p => p.test(relPath))) continue;
      if (extensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) files.push(fullPath);
    }
  }
  walk(dir);
  return files;
}

function extractEnvVars(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const envVars = new Set();
  const cleanedContent = content.split("\n").map(stripComments).join("\n");
  let match;
  const processEnvPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  while ((match = processEnvPattern.exec(cleanedContent)) !== null) envVars.add(match[1]);
  const nextPublicPattern = /\b(NEXT_PUBLIC_[A-Z_][A-Z0-9_]*)\b/g;
  while ((match = nextPublicPattern.exec(cleanedContent)) !== null) envVars.add(match[1]);
  return envVars;
}

function extractDocumentedVars(envExamplePath) {
  if (!existsSync(envExamplePath)) return new Set();
  const content = readFileSync(envExamplePath, "utf-8");
  const documented = new Set();
  const pattern = /^([A-Z_][A-Z0-9_]*)=/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) documented.add(match[1]);
  return documented;
}

function checkEnvSync() {
  console.log("Checking environment variable documentation...\n");
  const sourceFiles = collectFiles(ROOT_DIR);
  console.log(`Found ${sourceFiles.length} source files\n`);
  const allEnvVars = new Map();
  for (const file of sourceFiles) {
    const envVars = extractEnvVars(file);
    for (const envVar of envVars) {
      if (!allEnvVars.has(envVar)) allEnvVars.set(envVar, new Set());
      allEnvVars.get(envVar).add(relative(ROOT_DIR, file).replace(/\\/g, "/"));
    }
  }
  const envExamplePath = join(ROOT_DIR, ".env.example");
  const documentedVars = extractDocumentedVars(envExamplePath);
  console.log(`Found ${documentedVars.size} variables in .env.example\n`);
  const missingVars = [];
  for (const [envVar, files] of allEnvVars) {
    if (SYSTEM_ENV_VARS.has(envVar)) continue;
    if (!documentedVars.has(envVar)) missingVars.push({ envVar, files: [...files] });
  }
  if (missingVars.length === 0) {
    console.log("All environment variables are documented in .env.example");
    return true;
  }
  console.log(`Found ${missingVars.length} undocumented environment variable(s):\n`);
  for (const { envVar, files } of missingVars) {
    console.log(`  ${envVar}`);
    console.log(`    Used in:`);
    for (const file of files) console.log(`      - ${file}`);
    console.log();
  }
  console.log("Add these variables to .env.example\n");
  return false;
}

const success = checkEnvSync();
process.exit(success ? 0 : 1);
