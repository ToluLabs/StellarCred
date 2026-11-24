const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  NOIR_VERSION,
  BB_VERSION,
  CIRCUITS,
  loadCommitted,
} = require('../circuits/scripts/testvectors');

describe('Circuit Toolchain & Pinned Build Verification (#819)', () => {
  it('pins the correct versions of Noir and Barretenberg in testvectors script', () => {
    assert.strictEqual(NOIR_VERSION, '1.0.0-beta.9');
    assert.strictEqual(BB_VERSION, '0.87.0');
  });

  it('includes representative circuit kyc_proof in test vectors circuits list', () => {
    assert.ok(CIRCUITS.includes('kyc_proof'), 'kyc_proof should be in CIRCUITS list');
  });

  it('validates representative circuit kyc_proof committed testvector fixture', () => {
    const kycVector = loadCommitted('kyc_proof');
    assert.ok(kycVector, 'kyc_proof test vector fixture must exist');
    assert.strictEqual(kycVector.circuit, 'kyc_proof');
    assert.strictEqual(kycVector.noir_version, '1.0.0-beta.9');
    assert.strictEqual(kycVector.bb_version, '0.87.0');
    assert.strictEqual(kycVector.vk_hash_algo, 'sha256');
    assert.ok(kycVector.vk_hash, 'vk_hash must be present');
    assert.strictEqual(typeof kycVector.vk_hash, 'string');
    assert.strictEqual(kycVector.vk_hash.length, 64);
    assert.ok(Array.isArray(kycVector.public_inputs), 'public_inputs must be an array');
    assert.strictEqual(kycVector.public_inputs.length, 65, 'kyc_proof has 65 public inputs (1 commitment + 32 issuer_x + 32 issuer_y)');
  });

  it('verifies that build.sh and testvectors.js have consistent toolchain version pins', () => {
    const buildSh = fs.readFileSync(path.join(__dirname, '../circuits/scripts/build.sh'), 'utf8');
    assert.ok(buildSh.includes(`NOIR_VERSION="${NOIR_VERSION}"`));
    assert.ok(buildSh.includes(`BB_VERSION="${BB_VERSION}"`));
  });

  it('verifies that circuits/README.md references the pinned toolchain', () => {
    const readme = fs.readFileSync(path.join(__dirname, '../circuits/README.md'), 'utf8');
    assert.ok(readme.includes(NOIR_VERSION));
    assert.ok(readme.includes(BB_VERSION));
    assert.ok(readme.includes('node circuits/scripts/testvectors.js check kyc_proof'));
  });
});
