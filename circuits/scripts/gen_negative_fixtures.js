// Generate negative test fixtures for proof validation across all credential circuits.
// These are well-formed or slightly mutated proofs that should be rejected for semantic reasons.
//
// This script modifies existing valid fixtures to create semantically invalid ones,
// rather than generating new proofs from scratch. This keeps the fixture set small
// and makes regeneration straightforward.
//
// Layout: fixtures/negative/<case>/{vk,,proof,public_inputs}
// (matches the `fixture!("negative/<case>", "<file>")` macro paths used by
// contracts/credential_verifier/src/test.rs)
//
// Concurrency safety:
// This script is designed to be run concurrently with other proof generation jobs.
// All shared resources (fixture directories) are guarded by an exclusive lock file
// so two invocations cannot interleave writes and produce corrupted fixtures.
// Each case is also written to a temporary directory and then atomically renamed
// into place, so a crash midway through cannot leave a half-written fixture.

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const FIXTURES = path.join(REPO, 'fixtures');
const NEGATIVE_FIXTURES = path.join(FIXTURES, 'negative');
const LOCK_FILE = path.join(FIXTURES, '.negative-fixtures.lock');

const LOCK_TIMEOUT_MS = 60 * 1000;
const LOCK_REFRESH_MS = 100;

// Acquire an exclusive lock for the fixture generation critical section.
// Uses fs.openSync(LOCK_FILE, 'wx') for atomicity across processes.
function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* already released */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Stale lock detection: if the owning process is gone, remove the lock.
      try {
        const owner = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
        if (Number.isFinite(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (killErr) {
            // ESRCH means the process is gone -> stale lock.
            if (killErr.code === 'ESRCH') {
              try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* raced */ }
            }
          }
        }
      } catch (_) { /* ignore unreadable lock */ }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for fixture lock at ${LOCK_FILE}`);
      }
      // Blocking sleep without busy-waiting the CPU too hard.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_REFRESH_MS);
    }
  }
}

// Atomically publish a fixture directory: write into a unique temp dir, then rename.
function publishFixture(caseName, files) {
  const targetDir = path.join(NEGATIVE_FIXTURES, caseName);
  const tmpDir = path.join(
    NEGATIVE_FIXTURES,
    `.${caseName}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    for (const [name, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmpDir, name), data);
    }
    // Replace any previous fixture appearing at the target path.
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.renameSync(tmpDir, targetDir);
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw err;
  }
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

  const publicInputs = fs.readFileSync(inputsPath);
  const files = {
    proof: fs.readFileSync(proofPath),
    vk: fs.readFileSync(vkPath),
    public_inputs: modifyPublicInputsFn ? modifyPublicInputsFn(publicInputs) : publicInputs,
  };
  publishFixture(caseName, files);
  console.log(`  -> fixtures/negative/${caseName}/{proof,public_inputs,vk}`);
  return true;
}

function main() {
  const releaseLock = acquireLock();
  try {
    console.log('Generating comprehensive negative fixtures for all circuits...');

    // Create negative fixtures directory
    if (!fs.existsSync(NEGATIVE_FIXTURES)) {
      fs.mkdirSync(NEGATIVE_FIXTURES, { recursive: true });
    }

    // 1. KYC Circuit Negative Fixtures
    console.log('1. KYC Negative Fixtures...');
    // KYC public_inputs: commitment (32 bytes) + issuer_x (32 bytes) + issuer_y (32 bytes)
    // We'll keep commitment but replace issuer_x/issuer_y with zeros (clearly different)
    helperCopyFixture('kyc', 'kyc_wrong_issuer', (inputs) => {
      const commitment = inputs.slice(0, 32);
      return Buffer.concat([commitment, Buffer.alloc(32, 0), Buffer.alloc(32, 0)]);
    });
    // KYC public_inputs should be 96 bytes (32 + 32 + 32)
    // Truncate to 64 bytes (missing issuer_y)
    helperCopyFixture('kyc', 'kyc_truncated_inputs', (inputs) => inputs.slice(0, 64));
    // Proof from wrong circuit type (age proof verified against kyc VK)
    if (fs.existsSync(path.join(FIXTURES, 'age', 'proof')) &&
        fs.existsSync(path.join(FIXTURES, 'age', 'public_inputs')) &&
        fs.existsSync(path.join(FIXTURES, 'kyc', 'vk'))) {
      publishFixture('kyc_wrong_circuit', {
        proof: fs.readFileSync(path.join(FIXTURES, 'age', 'proof')),
        public_inputs: fs.readFileSync(path.join(FIXTURES, 'age', 'public_inputs')),
        vk: fs.readFileSync(path.join(FIXTURES, 'kyc', 'vk')),
      });
      console.log('  -> fixtures/negative/kyc_wrong_circuit/{proof,public_inputs,vk}');
    } else {
      console.log('  [Skipped] kyc_wrong_circuit: required age/kyc fixtures missing.');
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
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main();
}

module.exports = { acquireLock, publishFixture, main };