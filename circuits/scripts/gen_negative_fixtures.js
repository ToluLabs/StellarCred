// Generate negative test fixtures for proof validation.
// These are well-formed proofs that should be rejected for semantic reasons.
//
// This script modifies existing valid fixtures to create semantically invalid ones,
// rather than generating new proofs from scratch. This keeps the fixture set small
// and makes regeneration straightforward.

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
fs.copyFileSync(
  path.join(FIXTURES, 'kyc', 'proof'),
  path.join(NEGATIVE_FIXTURES, 'kyc_wrong_issuer_proof')
);
fs.copyFileSync(
  path.join(FIXTURES, 'kyc', 'vk'),
  path.join(NEGATIVE_FIXTURES, 'kyc_wrong_issuer_vk')
);

// KYC public_inputs: commitment (32 bytes) + issuer_x (32 bytes) + issuer_y (32 bytes)
// We'll keep commitment but replace issuer_x/issuer_y with zeros (clearly different)
const kycPublicInputs = fs.readFileSync(path.join(FIXTURES, 'kyc', 'public_inputs'));
const commitment = kycPublicInputs.slice(0, 32);
const differentIssuerX = Buffer.alloc(32, 0); // All zeros
const differentIssuerY = Buffer.alloc(32, 0); // All zeros
const wrongIssuerInputs = Buffer.concat([commitment, differentIssuerX, differentIssuerY]);
fs.writeFileSync(
  path.join(NEGATIVE_FIXTURES, 'kyc_wrong_issuer_public_inputs'),
  wrongIssuerInputs
);
console.log('  -> fixtures/negative/kyc_wrong_issuer_{proof,public_inputs,vk}');

// 2. Proof for unmet threshold (income below threshold)
// This requires running nargo and bb, which we'll document as a manual step
console.log('2. Proof for unmet threshold (income)...');
console.log('  -> Manual step: See documentation for generating income_unmet_threshold fixtures');

// 3. Proof with truncated public inputs (wrong count)
console.log('3. Proof with truncated public inputs...');
fs.copyFileSync(
  path.join(FIXTURES, 'kyc', 'proof'),
  path.join(NEGATIVE_FIXTURES, 'kyc_truncated_inputs_proof')
);
fs.copyFileSync(
  path.join(FIXTURES, 'kyc', 'vk'),
  path.join(NEGATIVE_FIXTURES, 'kyc_truncated_inputs_vk')
);

// KYC public_inputs should be 96 bytes (32 + 32 + 32)
// Truncate to 64 bytes (missing issuer_y)
const truncatedInputs = kycPublicInputs.slice(0, 64);
fs.writeFileSync(
  path.join(NEGATIVE_FIXTURES, 'kyc_truncated_inputs_public_inputs'),
  truncatedInputs
);
console.log('  -> fixtures/negative/kyc_truncated_inputs_{proof,public_inputs,vk}');

// 4. Proof from wrong circuit type (age proof with kyc VK)
console.log('4. Proof from wrong circuit type (age proof with kyc VK)...');
fs.copyFileSync(
  path.join(FIXTURES, 'age', 'proof'),
  path.join(NEGATIVE_FIXTURES, 'kyc_wrong_circuit_proof')
);
fs.copyFileSync(
  path.join(FIXTURES, 'age', 'public_inputs'),
  path.join(NEGATIVE_FIXTURES, 'kyc_wrong_circuit_public_inputs')
);
fs.copyFileSync(
  path.join(FIXTURES, 'kyc', 'vk'),
  path.join(NEGATIVE_FIXTURES, 'kyc_wrong_circuit_vk')
);
console.log('  -> fixtures/negative/kyc_wrong_circuit_{proof,public_inputs,vk}');

console.log('done. Negative fixtures generated in', NEGATIVE_FIXTURES);
