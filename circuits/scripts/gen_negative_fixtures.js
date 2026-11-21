// Generate negative test fixtures for proof validation across all credential circuits.
// These are well-formed or slightly mutated proofs that should be rejected for semantic reasons.

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const FIXTURES = path.join(REPO, 'fixtures');
const NEGATIVE_FIXTURES = path.join(FIXTURES, 'negative');

console.log('Generating comprehensive negative fixtures for all circuits...');

if (!fs.existsSync(NEGATIVE_FIXTURES)) {
  fs.mkdirSync(NEGATIVE_FIXTURES, { recursive: true });
}

function helperCopyFixture(circuit, caseName, modifyPublicInputsFn = null) {
  const srcDir = path.join(FIXTURES, circuit);
  const proofPath = path.join(srcDir, 'proof');
  const vkPath = path.join(srcDir, 'vk');
  const inputsPath = path.join(srcDir, 'public_inputs');

  if (!fs.existsSync(proofPath) || !fs.existsSync(vkPath) || !fs.existsSync(inputsPath)) {
    console.log(`  [Skipped] Fixture directory for '${circuit}' missing required files.`);
    return false;
  }

  const caseDir = path.join(NEGATIVE_FIXTURES, caseName);
  fs.mkdirSync(caseDir, { recursive: true });

  fs.copyFileSync(proofPath, path.join(caseDir, 'proof'));
  fs.copyFileSync(vkPath, path.join(caseDir, 'vk'));

  const publicInputs = fs.readFileSync(inputsPath);
  if (modifyPublicInputsFn) {
    const modified = modifyPublicInputsFn(publicInputs);
    fs.writeFileSync(path.join(caseDir, 'public_inputs'), modified);
  } else {
    fs.copyFileSync(inputsPath, path.join(caseDir, 'public_inputs'));
  }
  console.log(`  -> fixtures/negative/${caseName}/{proof,public_inputs,vk}`);
  return true;
}

// 1. KYC Circuit Negative Fixtures
console.log('1. KYC Negative Fixtures...');
helperCopyFixture('kyc', 'kyc_wrong_issuer', (inputs) => {
  const commitment = inputs.slice(0, 32);
  return Buffer.concat([commitment, Buffer.alloc(32, 0), Buffer.alloc(32, 0)]);
});
helperCopyFixture('kyc', 'kyc_truncated_inputs', (inputs) => inputs.slice(0, 64));
helperCopyFixture('kyc', 'kyc_wrong_circuit', null); // Age proof against KYC VK
if (fs.existsSync(path.join(FIXTURES, 'age', 'proof'))) {
  fs.copyFileSync(path.join(FIXTURES, 'age', 'proof'), path.join(NEGATIVE_FIXTURES, 'kyc_wrong_circuit', 'proof'));
  fs.copyFileSync(path.join(FIXTURES, 'age', 'public_inputs'), path.join(NEGATIVE_FIXTURES, 'kyc_wrong_circuit', 'public_inputs'));
}

// 2. Threshold Circuits (Age, Income, Funds, Range)
console.log('2. Threshold Circuit Negative Fixtures (Threshold Unmet)...');
const thresholdCircuits = ['age', 'income', 'funds', 'range'];
thresholdCircuits.forEach((circuit) => {
  helperCopyFixture(circuit, `${circuit}_unmet_threshold`, (inputs) => {
    const mutated = Buffer.from(inputs);
    if (mutated.length >= 32) {
      mutated[0] = mutated[0] === 0 ? 1 : 0;
    }
    return mutated;
  });
});

// 3. Jurisdiction Circuit
console.log('3. Jurisdiction Negative Fixtures (Denylisted Country)...');
helperCopyFixture('jurisdiction', 'jurisdiction_denylisted', (inputs) => {
  const mutated = Buffer.from(inputs);
  mutated.fill(0xff, 0, Math.min(32, mutated.length));
  return mutated;
});

// 4. Set Membership Circuit (Wrong Merkle Root)
console.log('4. Set Membership Negative Fixtures (Wrong Merkle Root)...');
helperCopyFixture('set_membership', 'set_membership_wrong_root', (inputs) => {
  const mutated = Buffer.from(inputs);
  mutated.fill(0xde, 0, Math.min(32, mutated.length));
  return mutated;
});

// 5. Aggregate Circuit (Malformed Field-Offset Layout)
console.log('5. Aggregate Negative Fixtures (Malformed Layout)...');
helperCopyFixture('aggregate', 'aggregate_malformed_layout', (inputs) => {
  return inputs.slice(0, Math.max(16, inputs.length - 32));
});

// 6. Remaining Circuits (Accreditation, Employment, Commit, Commit3)
console.log('6. Remaining Credential Circuits Negative Fixtures...');
const remainingCircuits = ['accreditation', 'employment', 'commit', 'commit3'];
remainingCircuits.forEach((circuit) => {
  helperCopyFixture(circuit, `${circuit}_invalid_proof`, (inputs) => {
    const mutated = Buffer.from(inputs);
    if (mutated.length >= 32) {
      mutated[mutated.length - 1] ^= 0xff;
    }
    return mutated;
  });
});

console.log('Done generating all negative fixtures!');
