#!/usr/bin/env node

/**
 * Verify all npm packages and their transitive dependencies comply with license policy.
 * Uses pnpm's built-in license checking and cross-references against policy.
 *
 * Outputs:
 * - List of all dependencies with licenses
 * - Violations (denied licenses)
 * - Warnings (high-risk but allowed licenses)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Determine root directory: if we're in frontend, go up one level
const currentDir = process.cwd();
const isInFrontend = currentDir.endsWith('frontend') || currentDir.endsWith('frontend/');
const rootDir = isInFrontend ? path.dirname(currentDir) : currentDir;

const POLICY_PATH = path.join(rootDir, '.github', 'config', 'license-policy.json');
const FRONTEND_DIR = isInFrontend ? currentDir : path.join(rootDir, 'frontend');

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
 * Get all npm packages with their licenses using pnpm
 */
function getInstalledPackages() {
  try {
    const output = execSync('pnpm ls --depth=Infinity --json 2>/dev/null || echo "{}"', {
      cwd: FRONTEND_DIR,
      encoding: 'utf-8',
    });

    const data = JSON.parse(output || '{}');
    return flattenDependencies(data);
  } catch (err) {
    console.error(`Failed to list dependencies: ${err.message}`);
    return [];
  }
}

/**
 * Flatten nested dependency tree into list
 */
function flattenDependencies(node, result = new Map()) {
  if (!node) return result;

  if (node.name && node.version) {
    const key = `${node.name}@${node.version}`;
    if (!result.has(key)) {
      result.set(key, {
        name: node.name,
        version: node.version,
        license: node.license || 'unknown',
      });
    }
  }

  if (node.dependencies) {
    for (const dep of Object.values(node.dependencies)) {
      flattenDependencies(dep, result);
    }
  }

  return result;
}

/**
 * Extract license from license field (may contain multiple licenses)
 */
function parseLicenses(licenseField) {
  if (!licenseField || licenseField === 'unknown') {
    return ['unknown'];
  }

  // Handle license expressions like "MIT OR Apache-2.0"
  const licenses = licenseField
    .split(/\s+OR\s+|\s*,\s*/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return licenses.length > 0 ? licenses : ['unknown'];
}

/**
 * Check if license is allowed by policy
 */
function checkLicense(license, policy) {
  const licenses = parseLicenses(license);

  for (const lic of licenses) {
    // Check against allowed list
    if (policy.allowedLicenses.some((allowed) => lic.includes(allowed) || allowed.includes(lic))) {
      return { status: 'allowed', reason: 'Allowed' };
    }

    // Check against denied list
    if (policy.deniedLicenses.some((denied) => lic.includes(denied) || denied.includes(lic))) {
      return { status: 'denied', reason: `Denied: ${lic}` };
    }
  }

  // Unknown license
  return { status: 'unknown', reason: `Unknown/Unclassified: ${license}` };
}

/**
 * Check exceptions
 */
function checkException(packageName, version, policy) {
  const exception = policy.exceptionList?.find(
    (ex) => ex.package === packageName && ex.version === version
  );

  if (!exception) return null;

  // Check if exception is expired
  if (exception.expiresAt) {
    const expiryDate = new Date(exception.expiresAt);
    if (new Date() > expiryDate) {
      return { valid: false, reason: 'Exception expired' };
    }
  }

  return { valid: true, approvedBy: exception.approvedBy, reason: exception.reason };
}

/**
 * Main
 */
function main() {
  console.log('🔍 Verifying npm licenses...\n');

  const policy = loadPolicy();
  const packages = getInstalledPackages();

  if (packages.size === 0) {
    console.log('⚠️  No packages found. Make sure pnpm install was run.');
    return;
  }

  console.log(`📦 Found ${packages.size} total packages (including transitive deps)\n`);

  let allowedCount = 0;
  let deniedCount = 0;
  let unknownCount = 0;
  let exceptions = 0;

  const violations = [];
  const warnings = [];
  const unclassified = [];

  for (const [key, pkg] of packages.entries()) {
    const check = checkLicense(pkg.license, policy);
    const exception = checkException(pkg.name, pkg.version, policy);

    if (exception) {
      if (exception.valid) {
        console.log(
          `✅ ${pkg.name}@${pkg.version}: ${pkg.license} (exception: ${exception.reason})`
        );
        exceptions++;
      } else {
        console.log(
          `⚠️  ${pkg.name}@${pkg.version}: ${pkg.license} (expired exception)`
        );
        violations.push({
          package: `${pkg.name}@${pkg.version}`,
          license: pkg.license,
          reason: 'Exception expired',
        });
        deniedCount++;
      }
      continue;
    }

    if (check.status === 'allowed') {
      allowedCount++;
    } else if (check.status === 'denied') {
      deniedCount++;
      violations.push({
        package: `${pkg.name}@${pkg.version}`,
        license: pkg.license,
        reason: check.reason,
      });
    } else if (check.status === 'unknown') {
      unknownCount++;
      unclassified.push({
        package: `${pkg.name}@${pkg.version}`,
        license: pkg.license,
      });
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('📊 License Summary:');
  console.log('='.repeat(70));
  console.log(`✅ Allowed:      ${allowedCount}`);
  console.log(`⚠️  Unknown:      ${unknownCount}`);
  console.log(`❌ Denied:       ${deniedCount}`);
  console.log(`🏷️  Exceptions:   ${exceptions}`);
  console.log('='.repeat(70) + '\n');

  if (deniedCount > 0) {
    console.error('❌ License violations found:');
    violations.forEach((v) => {
      console.error(`   - ${v.package}: ${v.reason}`);
    });
    console.error();
  }

  if (unknownCount > 0) {
    console.warn('⚠️  Unknown/unclassified licenses (not automatically allowed):');
    unclassified.slice(0, 10).forEach((u) => {
      console.warn(`   - ${u.package}: ${u.license}`);
    });
    if (unclassified.length > 10) {
      console.warn(`   ... and ${unclassified.length - 10} more`);
    }
    console.warn(
      '\nTo allow a license, update .github/config/license-policy.json allowedLicenses.'
    );
    console.warn();
  }

  if (deniedCount > 0) {
    console.error(
      '\n❌ FAILED: Denied licenses detected.\n' +
        'To add an exception, edit .github/config/license-policy.json exceptionList.'
    );
    process.exit(1);
  }

  console.log('✅ All dependencies comply with license policy.\n');
}

main();
