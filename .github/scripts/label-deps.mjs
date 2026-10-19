#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Dry-run helper for the auto-labeling GitHub Action.
 *
 * Reads the current `package.json` (default: `frontend/package.json`) and prints
 * the dependency groups that the action would label, without creating anything
 * on GitHub. Run this script from the repository root:
 *
 *   node .github/scripts/label-deps.mjs
 *
 * It exits 0 when the action logic is correct and 1 when the output shows
 * dependency groups it could not resolve.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(selfDir, '..', '..');
const defaultPkgPath = resolve(rootDir, 'frontend', 'package.json');

function readPackageJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`ERROR: Failed to read ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

function main() {
  const pkgPath = process.argv[2] || defaultPkgPath;
  const pkg = readPackageJson(pkgPath);

  const dependencyGroups = [];
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    dependencyGroups.push({ group: 'dependencies', packages: pkg.dependencies });
  }
  if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) {
    dependencyGroups.push({ group: 'devDependencies', packages: pkg.devDependencies });
  }
  if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0) {
    dependencyGroups.push({ group: 'peerDependencies', packages: pkg.peerDependencies });
  }
  if (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length > 0) {
    dependencyGroups.push({ group: 'optionalDependencies', packages: pkg.optionalDependencies });
  }

  if (dependencyGroups.length === 0) {
    console.log('No dependency groups found in package.json');
    return;
  }

  console.log(`Dry-run for dependency labeler on ${pkgPath}`);
  for (const group of dependencyGroups) {
    console.log(`\nGroup: ${group.group}`);
    console.log('Packages:');
    for (const [name, version] of Object.entries(group.packages)) {
      console.log(`  ${name}@${version}`);
    }
  }
}

main();
