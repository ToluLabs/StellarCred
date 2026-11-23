#!/usr/bin/env node

/**
 * scripts/check-contract-abi.mjs
 *
 * Compares the public ABI for every release-bound contract against its checked-in
 * baseline (contracts/<name>/abi.json) so unintended breaking changes are caught
 * before deployment.
 *
 * Checks:
 *   - Removed public functions
 *   - Changed function parameters (type, count, order, name)
 *   - Changed function return types
 *   - Removed or altered structs, fields, and field types
 *   - Removed or altered error codes and enum variants
 *   - Byte-level / formatting drift in contract specifications
 *
 * Usage:
 *   node scripts/check-contract-abi.mjs [--no-build]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_BOUND_CONTRACTS } from './export-contract-abi.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

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

function runDiff(baselinePath, currentPath) {
  try {
    const diff = execSync(`git diff --no-index --color=never "${baselinePath}" "${currentPath}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return diff;
  } catch (err) {
    // git diff exits 1 when differences are found, returning stdout with the diff
    if (err.stdout) {
      return err.stdout.toString();
    }
    return null;
  }
}

/**
 * Performs structured comparison between two Soroban contract specification arrays.
 * Returns a list of human-readable diagnostic messages describing differences.
 */
function compareSpecs(contractName, baselineEntries, currentEntries) {
  const diffs = [];

  const indexEntries = (entries) => {
    const fns = new Map();
    const structs = new Map();
    const errors = new Map();
    const enums = new Map();
    const unions = new Map();

    for (const entry of entries) {
      if (entry.function_v0) {
        fns.set(entry.function_v0.name, entry.function_v0);
      } else if (entry.udt_struct_v0) {
        structs.set(entry.udt_struct_v0.name, entry.udt_struct_v0);
      } else if (entry.udt_error_enum_v0) {
        errors.set(entry.udt_error_enum_v0.name, entry.udt_error_enum_v0);
      } else if (entry.udt_enum_v0) {
        enums.set(entry.udt_enum_v0.name, entry.udt_enum_v0);
      } else if (entry.udt_union_v0) {
        unions.set(entry.udt_union_v0.name, entry.udt_union_v0);
      }
    }

    return { fns, structs, errors, enums, unions };
  };

  const base = indexEntries(baselineEntries);
  const curr = indexEntries(currentEntries);

  // 1. Functions
  for (const [fnName, baseFn] of base.fns.entries()) {
    if (!curr.fns.has(fnName)) {
      diffs.push(`[BREAKING] Function '${fnName}' was REMOVED.`);
      continue;
    }
    const currFn = curr.fns.get(fnName);

    // Inputs (parameters) count
    const baseInputs = baseFn.inputs || [];
    const currInputs = currFn.inputs || [];
    if (baseInputs.length !== currInputs.length) {
      diffs.push(
        `[BREAKING] Function '${fnName}' parameter count changed:\n` +
        `  Baseline (${baseInputs.length}): [${baseInputs.map(p => `${p.name}: ${JSON.stringify(p.type_)}`).join(', ')}]\n` +
        `  Current  (${currInputs.length}): [${currInputs.map(p => `${p.name}: ${JSON.stringify(p.type_)}`).join(', ')}]`
      );
    } else {
      for (let i = 0; i < baseInputs.length; i++) {
        const bParam = baseInputs[i];
        const cParam = currInputs[i];
        if (bParam.name !== cParam.name) {
          diffs.push(
            `[CHANGE] Function '${fnName}' parameter #${i + 1} renamed: '${bParam.name}' -> '${cParam.name}'.`
          );
        }
        if (JSON.stringify(bParam.type_) !== JSON.stringify(cParam.type_)) {
          diffs.push(
            `[BREAKING] Function '${fnName}' parameter '${cParam.name}' type changed:\n` +
            `  Baseline: ${JSON.stringify(bParam.type_)}\n` +
            `  Current:  ${JSON.stringify(cParam.type_)}`
          );
        }
      }
    }

    // Outputs (return types)
    const baseOutputs = baseFn.outputs || [];
    const currOutputs = currFn.outputs || [];
    if (JSON.stringify(baseOutputs) !== JSON.stringify(currOutputs)) {
      diffs.push(
        `[BREAKING] Function '${fnName}' return type changed:\n` +
        `  Baseline: ${JSON.stringify(baseOutputs)}\n` +
        `  Current:  ${JSON.stringify(currOutputs)}`
      );
    }
  }

  for (const fnName of curr.fns.keys()) {
    if (!base.fns.has(fnName)) {
      diffs.push(`[NEW] Function '${fnName}' was ADDED to public interface.`);
    }
  }

  // 2. Structs
  for (const [structName, baseStruct] of base.structs.entries()) {
    if (!curr.structs.has(structName)) {
      diffs.push(`[BREAKING] Struct '${structName}' was REMOVED.`);
      continue;
    }
    const currStruct = curr.structs.get(structName);
    const baseFields = new Map((baseStruct.fields || []).map(f => [f.name, f]));
    const currFields = new Map((currStruct.fields || []).map(f => [f.name, f]));

    for (const [fName, bField] of baseFields.entries()) {
      if (!currFields.has(fName)) {
        diffs.push(`[BREAKING] Struct '${structName}' field '${fName}' was REMOVED.`);
      } else {
        const cField = currFields.get(fName);
        if (JSON.stringify(bField.type_) !== JSON.stringify(cField.type_)) {
          diffs.push(
            `[BREAKING] Struct '${structName}' field '${fName}' type changed:\n` +
            `  Baseline: ${JSON.stringify(bField.type_)}\n` +
            `  Current:  ${JSON.stringify(cField.type_)}`
          );
        }
      }
    }
    for (const fName of currFields.keys()) {
      if (!baseFields.has(fName)) {
        diffs.push(`[CHANGE] Struct '${structName}' field '${fName}' was ADDED.`);
      }
    }
  }

  for (const structName of curr.structs.keys()) {
    if (!base.structs.has(structName)) {
      diffs.push(`[NEW] Struct '${structName}' was ADDED.`);
    }
  }

  // 3. Error Enums
  for (const [errName, baseErr] of base.errors.entries()) {
    if (!curr.errors.has(errName)) {
      diffs.push(`[BREAKING] Error enum '${errName}' was REMOVED.`);
      continue;
    }
    const currErr = curr.errors.get(errName);
    const baseCases = new Map((baseErr.cases || []).map(c => [c.name, c.value]));
    const currCases = new Map((currErr.cases || []).map(c => [c.name, c.value]));

    for (const [cName, bVal] of baseCases.entries()) {
      if (!currCases.has(cName)) {
        diffs.push(`[BREAKING] Error enum '${errName}' case '${cName}' was REMOVED.`);
      } else if (bVal !== currCases.get(cName)) {
        diffs.push(
          `[BREAKING] Error enum '${errName}' case '${cName}' value changed:\n` +
          `  Baseline: ${bVal}\n` +
          `  Current:  ${currCases.get(cName)}`
        );
      }
    }
    for (const cName of currCases.keys()) {
      if (!baseCases.has(cName)) {
        diffs.push(`[NEW] Error enum '${errName}' case '${cName}' was ADDED.`);
      }
    }
  }

  // 4. Enums and Unions
  for (const [unionName, baseUnion] of base.unions.entries()) {
    if (!curr.unions.has(unionName)) {
      diffs.push(`[BREAKING] Union '${unionName}' was REMOVED.`);
    }
  }
  for (const [enumName, baseEnum] of base.enums.entries()) {
    if (!curr.enums.has(enumName)) {
      diffs.push(`[BREAKING] Enum '${enumName}' was REMOVED.`);
    }
  }

  return diffs;
}

export function checkContractAbi(options = {}) {
  const shouldBuild = !options.noBuild;
  const stellarBin = findStellarCli();

  if (!stellarBin) {
    console.error(
      'Error: Stellar CLI (stellar or soroban) is required to inspect and check contract ABIs.\n' +
      'Please install it via: cargo install stellar-cli --locked --version 27.0.0'
    );
    process.exit(1);
  }

  const targetDir = process.env.CARGO_TARGET_DIR
    ? path.resolve(process.env.CARGO_TARGET_DIR, 'wasm32v1-none', 'release')
    : path.join(REPO_ROOT, 'target', 'wasm32v1-none', 'release');

  // Ensure WASM artifacts exist; build if missing or requested
  const missingArtifacts = RELEASE_BOUND_CONTRACTS.filter(
    (c) => !fs.existsSync(path.join(targetDir, `${c}.wasm`))
  );

  if (shouldBuild || missingArtifacts.length > 0) {
    console.log('==> Building release-bound contracts to wasm32v1-none (release)...');
    try {
      execSync('cargo build --release --target wasm32v1-none --locked', {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
    } catch {
      console.error('Error: Failed to build contract WASM artifacts.');
      process.exit(1);
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarcred-abi-'));
  let failureCount = 0;

  console.log('==> Checking public contract ABIs against checked-in baselines...\n');

  for (const contract of RELEASE_BOUND_CONTRACTS) {
    const wasmPath = path.join(targetDir, `${contract}.wasm`);
    const baselinePath = path.join(REPO_ROOT, 'contracts', contract, 'abi.json');
    const currentTempPath = path.join(tempDir, `${contract}.json`);

    if (!fs.existsSync(baselinePath)) {
      console.error(
        `❌ FAIL: Missing baseline ABI for contract '${contract}' at ${baselinePath}.\n` +
        `  Run 'node scripts/export-contract-abi.mjs' to generate the initial baseline.`
      );
      failureCount++;
      continue;
    }

    if (!fs.existsSync(wasmPath)) {
      console.error(`❌ FAIL: WASM artifact not found at ${wasmPath}.`);
      failureCount++;
      continue;
    }

    // Export current ABI from WASM
    let rawCurrent;
    try {
      try {
        rawCurrent = execSync(
          `${stellarBin} --quiet contract info interface --wasm "${wasmPath}" --output json-formatted`,
          { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
        );
      } catch {
        rawCurrent = execSync(
          `${stellarBin} contract inspect --wasm "${wasmPath}" --output json`,
          { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
        );
      }
    } catch (err) {
      console.error(`❌ FAIL: Failed to inspect WASM for contract '${contract}': ${err.message}`);
      failureCount++;
      continue;
    }

    let parsedCurrent;
    try {
      parsedCurrent = JSON.parse(rawCurrent);
    } catch (err) {
      console.error(`❌ FAIL: Failed to parse exported ABI for '${contract}': ${err.message}`);
      failureCount++;
      continue;
    }

    const formattedCurrent = JSON.stringify(parsedCurrent, null, 2) + '\n';
    fs.writeFileSync(currentTempPath, formattedCurrent, 'utf8');

    const rawBaseline = fs.readFileSync(baselinePath, 'utf8');
    let parsedBaseline;
    try {
      parsedBaseline = JSON.parse(rawBaseline);
    } catch (err) {
      console.error(`❌ FAIL: Failed to parse checked-in baseline for '${contract}': ${err.message}`);
      failureCount++;
      continue;
    }

    const formattedBaseline = JSON.stringify(parsedBaseline, null, 2) + '\n';

    // Structured comparison
    const structuredDiffs = compareSpecs(contract, parsedBaseline, parsedCurrent);
    const rawDiff = formattedBaseline !== formattedCurrent;

    if (structuredDiffs.length > 0 || rawDiff) {
      failureCount++;
      console.error(`--------------------------------------------------------------------------------`);
      console.error(`❌ FAIL: Contract '${contract}' public ABI does NOT match checked-in baseline!`);
      console.error(`--------------------------------------------------------------------------------`);

      if (structuredDiffs.length > 0) {
        console.error('Detected ABI changes:');
        for (const diff of structuredDiffs) {
          console.error(`  • ${diff}`);
        }
      } else {
        console.error('  • Baseline specification formatting or metadata differ.');
      }

      console.error('\nUnified Diff (baseline vs current):');
      const diffOutput = runDiff(baselinePath, currentTempPath);
      if (diffOutput) {
        console.error(diffOutput);
      } else {
        console.error('  (diff command unavailable)');
      }
      console.error(`--------------------------------------------------------------------------------\n`);
    } else {
      console.log(`✓ PASS: Contract '${contract}' public ABI matches checked-in baseline.`);
    }
  }

  // Cleanup temp files
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }

  if (failureCount > 0) {
    console.error(
      `\n================================================================================\n` +
      `❌ CONTRACT ABI CHECK FAILED: ${failureCount} contract(s) have ABI drift or breaking changes.\n` +
      `\n` +
      `If this change was intentional, regenerate and review the baseline:\n` +
      `  1. Run: bash scripts/export-contract-abi.sh\n` +
      `  2. Review git diff for contracts/<name>/abi.json\n` +
      `  3. Follow docs/abi-baseline-update.md for review & approval requirements.\n` +
      `================================================================================\n`
    );
    process.exit(1);
  }

  console.log(
    `\n================================================================================\n` +
    `✓ CONTRACT ABI CHECK PASSED: All 4 release-bound contracts match their baseline.\n` +
    `================================================================================\n`
  );
  process.exit(0);
}

if (process.argv[1] === __filename) {
  const args = process.argv.slice(2);
  const noBuild = args.includes('--no-build');
  checkContractAbi({ noBuild });
}
