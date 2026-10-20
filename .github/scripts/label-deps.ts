/* eslint-disable @typescript-eslint/no-var-requires */

/**
 * Dependency label requirements for the auto-labeling GitHub Action.
 *
 * This file is a machine-generated script output; do not edit it by hand.
 * Regenerate with `node .github/scripts/label-deps.mjs`.
 */

const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, dirname } = require('node:path');

const rootDir = resolve(__dirname, '..', '..');
const pkgPath = resolve(rootDir, 'frontend', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const dependencyLabels = [];

if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  dependencyLabels.push(...Object.keys(pkg.dependencies).map((name) => `${name}@${pkg.dependencies[name]}`));
}
if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) {
  dependencyLabels.push(...Object.keys(pkg.devDependencies).map((name) => `${name}@${pkg.devDependencies[name]}`));
}
if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0) {
  dependencyLabels.push(...Object.keys(pkg.peerDependencies).map((name) => `${name}@${pkg.peerDependencies[name]}`));
}
if (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length > 0) {
  dependencyLabels.push(...Object.keys(pkg.optionalDependencies).map((name) => `${name}@${pkg.optionalDependencies[name]}`));
}

const outPath = resolve(rootDir, '.github', 'scripts', 'label-requirements.ts');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `/* eslint-disable @typescript-eslint/no-var-requires */

/** @type {string[]} */
exports.dependencyLabels = ${JSON.stringify(dependencyLabels)};
`);

console.log(`Detected ${dependencyLabels.length} dependency labels`);
