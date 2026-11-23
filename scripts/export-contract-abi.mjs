#!/usr/bin/env node

/**
 * scripts/export-contract-abi.mjs
 *
 * Exports the public ABI (Soroban contract specification interface) for every
 * release-bound contract in StellarCred to contracts/<name>/abi.json.
 *
 * Release-bound contracts:
 *   - contracts/credential_verifier
 *   - contracts/gated_pool
 *   - contracts/issuer_registry
 *   - contracts/proof_registry
 *
 * Usage:
 *   node scripts/export-contract-abi.mjs [--no-build]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const RELEASE_BOUND_CONTRACTS = [
  'credential_verifier',
  'gated_pool',
  'issuer_registry',
  'proof_registry',
];

function findStellarCli() {
  const candidates = ['stellar', 'soroban'];
  for (const bin of candidates) {
    try {
      execSync(`${bin} --version`, { stdio: 'ignore' });
      return bin;
    } catch {
      // try next
    }
  }
  return null;
}

export function exportContractAbi(options = {}) {
  const shouldBuild = !options.noBuild;
  const stellarBin = findStellarCli();

  if (!stellarBin) {
    console.error(
      'Error: Stellar CLI (stellar or soroban) is required to inspect and export contract ABIs.\n' +
      'Please install it via: cargo install stellar-cli --locked --version 27.0.0'
    );
    process.exit(1);
  }

  if (shouldBuild) {
    console.log('==> Building release-bound contracts to wasm32v1-none (release)...');
    try {
      execSync('cargo build --release --target wasm32v1-none --locked', {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
    } catch (err) {
      console.error('Error: Failed to build contract WASM artifacts.');
      process.exit(1);
    }
  }

  const targetDir = process.env.CARGO_TARGET_DIR
    ? path.resolve(process.env.CARGO_TARGET_DIR, 'wasm32v1-none', 'release')
    : path.join(REPO_ROOT, 'target', 'wasm32v1-none', 'release');

  console.log(`==> Exporting public ABI for release-bound contracts from ${targetDir}...`);

  let failureCount = 0;

  for (const contract of RELEASE_BOUND_CONTRACTS) {
    const wasmPath = path.join(targetDir, `${contract}.wasm`);
    const abiPath = path.join(REPO_ROOT, 'contracts', contract, 'abi.json');

    if (!fs.existsSync(wasmPath)) {
      console.error(`Error: WASM artifact not found: ${wasmPath}`);
      failureCount++;
      continue;
    }

    try {
      // stellar contract info interface --wasm <path> --output json-formatted
      let rawJson;
      try {
        rawJson = execSync(
          `${stellarBin} --quiet contract info interface --wasm "${wasmPath}" --output json-formatted`,
          { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
        );
      } catch {
        // Fallback for older soroban / stellar CLI versions supporting inspect
        rawJson = execSync(
          `${stellarBin} contract inspect --wasm "${wasmPath}" --output json`,
          { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
        );
      }

      const parsed = JSON.parse(rawJson);
      if (!Array.isArray(parsed)) {
        throw new Error('Expected JSON array of contract spec entries');
      }

      // Stable formatting: 2 spaces, trailing newline, pure UTF-8 without BOM
      const formatted = JSON.stringify(parsed, null, 2) + '\n';
      fs.writeFileSync(abiPath, formatted, 'utf8');
      console.log(`  ✓ Exported ${contract} (${parsed.length} entries) -> contracts/${contract}/abi.json`);
    } catch (err) {
      console.error(`Error: Failed to export ABI for ${contract}: ${err.message}`);
      failureCount++;
    }
  }

  if (failureCount > 0) {
    console.error(`\nError: ABI export failed for ${failureCount} contract(s).`);
    process.exit(1);
  }

  console.log('\n✓ All release-bound contract ABIs exported successfully.');
}

if (process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  const noBuild = args.includes('--no-build');
  exportContractAbi({ noBuild });
}
