// Generate negative test fixtures for proof validation.
// These are well-formed proofs that should be rejected for semantic reasons.
//
// This script modifies existing valid fixtures to create semantically invalid ones,
// rather than generating new proofs from scratch. This keeps the fixture set small
// and makes regeneration straightforward.
//
// Layout: fixtures/negative/<case>/{vk,proof,public_inputs}
// (matches the `fixture!("negative/<case>", "<file>")` macro paths used by
// contracts/credential_verifier/src/test.rs)

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const FIXTURES = path.join(REPO, 'fixtures');
const NEGATIVE_FIXTURES = path.join(FIXTURES, 'negative');

console.log('Generating negative fixtures...');

// Create negative fixtures directory
if (!fs.existsSync(NEGATIVE_FIXTURES)) {
  fs.mkdirSync(NEGATIVE_FIXTURES, { recursive: true });
}

// 1. Proof with wrong issuer pubkey
// Take valid kyc proof, modify public_inputs to use different issuer_x/issuer_y
console.log('1. Proof with wrong issuer pubkey...');
const wrongIssuerDir = path.join(NEGATIVE_FIXTURES, 'kyc_wrong_issuer');
fs.mkdirSync(wrongIssuerDir, { recursive: true });
fs.copyFileSync(path.join(FIXTURES, 'kyc', 'proof'), path.join(wrongIssuerDir, 'proof'));
fs.copyFileSync(path.join(FIXTURES, 'kyc', 'vk'), path.join(wrongIssuerDir, 'vk'));

// KYC public_inputs: commitment (32 bytes) + issuer_x (32 bytes) + issuer_y (32 bytes)
// We'll keep commitment but replace issuer_x/issuer_y with zeros (clearly different)
const kycPublicInputs = fs.readFileSync(path.join(FIXTURES, 'kyc', 'public_inputs'));
const commitment = kycPublicInputs.slice(0, 32);
const differentIssuerX = Buffer.alloc(32, 0); // All zeros
const differentIssuerY = Buffer.alloc(32, 0); // All zeros
const wrongIssuerInputs = Buffer.concat([commitment, differentIssuerX, differentIssuerY]);
fs.writeFileSync(path.join(wrongIssuerDir, 'public_inputs'), wrongIssuerInputs);
console.log('  -> fixtures/negative/kyc_wrong_issuer/{proof,public_inputs,vk}');

// 2. Proof for unmet threshold (income below threshold)
// This requires running nargo and bb, which we'll document as a manual step
console.log('2. Proof for unmet threshold (income)...');
console.log('  -> Manual step: See documentation for generating income_unmet_threshold fixtures');

// 3. Proof with truncated public inputs (wrong count)
console.log('3. Proof with truncated public inputs...');
const truncatedDir = path.join(NEGATIVE_FIXTURES, 'kyc_truncated_inputs');
fs.mkdirSync(truncatedDir, { recursive: true });
fs.copyFileSync(path.join(FIXTURES, 'kyc', 'proof'), path.join(truncatedDir, 'proof'));
fs.copyFileSync(path.join(FIXTURES, 'kyc', 'vk'), path.join(truncatedDir, 'vk'));

// KYC public_inputs should be 96 bytes (32 + 32 + 32)
// Truncate to 64 bytes (missing issuer_y)
const truncatedInputs = kycPublicInputs.slice(0, 64);
fs.writeFileSync(path.join(truncatedDir, 'public_inputs'), truncatedInputs);
console.log('  -> fixtures/negative/kyc_truncated_inputs/{proof,public_inputs,vk}');

// 4. Proof from wrong circuit type (age proof verified against kyc VK)
console.log('4. Proof from wrong circuit type (age proof with kyc VK)...');
const wrongCircuitDir = path.join(NEGATIVE_FIXTURES, 'kyc_wrong_circuit');
fs.mkdirSync(wrongCircuitDir, { recursive: true });
fs.copyFileSync(path.join(FIXTURES, 'age', 'proof'), path.join(wrongCircuitDir, 'proof'));
fs.copyFileSync(path.join(FIXTURES, 'age', 'public_inputs'), path.join(wrongCircuitDir, 'public_inputs'));
fs.copyFileSync(path.join(FIXTURES, 'kyc', 'vk'), path.join(wrongCircuitDir, 'vk'));
console.log('  -> fixtures/negative/kyc_wrong_circuit/{proof,public_inputs,vk}');

console.log('done. Negative fixtures generated in', NEGATIVE_FIXTURES);
