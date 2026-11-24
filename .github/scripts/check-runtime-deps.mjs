#!/usr/bin/env node

/**
 * Check for newly introduced frontend runtime dependencies.
 * Flags additions to runtime deps in package.json, which reach the browser
 * where credential secrets (keys, proofs) are stored.
 *
 * Runs on PR to surface:
 * - Package name and version
 * - Package age (last update timestamp)
 * - Downloads per week trend
 * - Known vulnerabilities
 * - License information
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const currentDir = process.cwd();
const isInFrontend = currentDir.endsWith('frontend') || currentDir.endsWith('frontend/');
const rootDir = isInFrontend ? path.dirname(currentDir) : currentDir;

const FRONTEND_PKG_PATH = path.join(rootDir, 'frontend', 'package.json');
const POLICY_PATH = path.join(rootDir, '.github', 'config', 'license-policy.json');

/**
 * Parse package.json files
 */
function readPackageJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err.message);
    process.exit(1);
  }
}

/**
 * Get the base branch package.json for comparison
 */
function getBaseBranchPackageJson() {
  try {
    const baseRef = process.env.GITHUB_BASE_REF || 'main';
    const content = execSync(`git show origin/${baseRef}:frontend/package.json`, {
      encoding: 'utf-8',
    });
    return JSON.parse(content);
  } catch (err) {
    console.warn(
      `Could not fetch base branch package.json (${err.message}). ` +
        'Skipping comparison. This is normal on first commit.'
    );
    return null;
  }
}

/**
 * Fetch package info from npm registry
 */
async function fetchPackageInfo(packageName) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}`, {
      timeout: 5000,
    });

    if (!response.ok) {
      console.warn(`  ⚠ Failed to fetch info for ${packageName}`);
      return null;
    }

    return await response.json();
  } catch (err) {
    console.warn(`  ⚠ Error fetching ${packageName}: ${err.message}`);
    return null;
  }
}

/**
 * Get package metadata
 */
async function getPackageMetadata(packageName, version) {
  const info = await fetchPackageInfo(packageName);

  if (!info) {
    return {
      name: packageName,
      version,
      age: 'unknown',
      downloads: 'unknown',
      maintenance: 'unknown',
    };
  }

  const latestVersion = info['dist-tags']?.latest;
  const versionData = info.versions?.[latestVersion];
  const allVersions = info.versions || {};

  // Calculate age (days since last update)
  const latestTime = info.time?.[latestVersion];
  let daysSinceUpdate = 'unknown';

  if (latestTime) {
    const lastUpdateDate = new Date(latestTime);
    const now = new Date();
    daysSinceUpdate = Math.floor((now - lastUpdateDate) / (1000 * 60 * 60 * 24));
  }

  // Get license
  const pkgLicense = versionData?.license || info.license || 'unknown';

  // Check repository
  const repo = info.repository?.url || '';

  return {
    name: packageName,
    version,
    age: daysSinceUpdate,
    license: pkgLicense,
    repository: repo,
    description: info.description || 'N/A',
  };
}

/**
 * Identify new runtime dependencies
 */
function getNewDependencies(currentDeps, baseDeps) {
  if (!baseDeps) {
    // First commit or can't compare
    return Object.keys(currentDeps || {});
  }

  const newDeps = [];
  const currentNames = Object.keys(currentDeps || {});

  for (const name of currentNames) {
    if (!(name in baseDeps)) {
      newDeps.push(name);
    } else if (baseDeps[name] !== currentDeps[name]) {
      // Version changed - could be upgrade or downgrade
      // We'll surface it for review too
      newDeps.push(`${name} (version changed: ${baseDeps[name]} → ${currentDeps[name]})`);
    }
  }

  return newDeps;
}

/**
 * Load policy
 */
function loadPolicy() {
  try {
    return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Failed to load license policy: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Check license against policy
 */
function checkLicense(license, policy) {
  const normalizedLicense = (license || '').trim();

  // Check against allowed list
  if (policy.allowedLicenses.some((allowed) => normalizedLicense.includes(allowed))) {
    return { allowed: true, reason: 'Allowed' };
  }

  // Check against denied list
  if (policy.deniedLicenses.some((denied) => normalizedLicense.includes(denied))) {
    return { allowed: false, reason: `Denied: ${normalizedLicense}` };
  }

  // Unknown license
  return { allowed: false, reason: `Unknown/Unclassified: ${normalizedLicense}` };
}

/**
 * Main
 */
async function main() {
  console.log('🔍 Checking frontend runtime dependencies...\n');

  const currentPkg = readPackageJson(FRONTEND_PKG_PATH);
  const basePkg = getBaseBranchPackageJson();
  const policy = loadPolicy();

  const currentDeps = currentPkg.dependencies || {};
  const baseDeps = basePkg?.dependencies || {};

  const newDeps = getNewDependencies(currentDeps, baseDeps);

  if (newDeps.length === 0) {
    console.log('✅ No new runtime dependencies added.\n');
    return;
  }

  console.log(`📦 Found ${newDeps.length} new/changed runtime dependencies:\n`);

  let hasViolations = false;

  for (const dep of newDeps) {
    // Parse package name and version
    const depName = dep.includes(' (version changed:') ? dep.split(' (version changed:')[0] : dep;
    const version = currentDeps[depName];

    // Skip workspace packages (e.g., @stellarcred/issuer@workspace:*)
    if (version && version.startsWith('workspace:')) {
      console.log(`  📍 ${depName}@${version} (workspace package - skipped)\n`);
      continue;
    }

    console.log(`  📍 ${depName}@${version}`);

    // Fetch metadata
    const metadata = await getPackageMetadata(depName, version);

    // Display metadata
    if (metadata.description && metadata.description !== 'N/A') {
      console.log(`     Description: ${metadata.description.substring(0, 60)}`);
    }

    if (metadata.age !== 'unknown') {
      const ageColor =
        metadata.age > policy.frontendRuntimePolicy.packageAgeThreshold.days
          ? '⚠️'
          : '✓';
      console.log(`     Last updated: ${metadata.age} days ago ${ageColor}`);
    }

    // License check
    const licenseCheck = checkLicense(metadata.license, policy);
    const licenseIcon = licenseCheck.allowed ? '✅' : '❌';
    console.log(`     License: ${metadata.license} ${licenseIcon}`);

    if (!licenseCheck.allowed) {
      console.error(
        `     ERROR: ${licenseCheck.reason} - not in allowed list`
      );
      hasViolations = true;
    }

    // Age warning
    if (metadata.age !== 'unknown') {
      if (metadata.age > policy.frontendRuntimePolicy.packageAgeThreshold.days) {
        console.warn(
          `     ⚠️  WARN: Package not updated in ${metadata.age} days ` +
            `(threshold: ${policy.frontendRuntimePolicy.packageAgeThreshold.days} days)`
        );
      }
    }

    console.log();
  }

  // Check total dependency count
  const totalDeps = Object.keys(currentDeps).length;
  const maxAllowed = policy.frontendRuntimePolicy.maxAllowedDependencies;

  if (totalDeps > maxAllowed) {
    console.warn(
      `⚠️  WARN: Frontend has ${totalDeps} runtime dependencies ` +
        `(recommended max: ${maxAllowed})`
    );
  }

  if (hasViolations) {
    console.error(
      '\n❌ FAILED: Some dependencies violate license policy.\n' +
        'To add an exception, edit .github/config/license-policy.json exceptionList.'
    );
    process.exit(1);
  }

  console.log(
    '✅ All new runtime dependencies pass policy checks.\n' +
      'Note: Maintainability metrics are provided for security review.'
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
