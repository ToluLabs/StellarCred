// Generate negative test fixtures for proof validation.
// These are well-formed proofs that should be rejected for semantic reasons.
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

function main() {
  const releaseLock = acquireLock();
  try {
    console.log('Generating negative fixtures...');

    // Create negative fixtures directory
    if (!fs.existsSync(NEGATIVE_FIXTURES)) {
      fs.mkdirSync(NEGATIVE_FIXTURES, { recursive: true });
    }

    // 1. Proof with wrong issuer pubkey
    // Take valid kyc proof, modify public_inputs to use different issuer_x/issuer_y
    console.log('1. Proof with wrong issuer pubkey...');
    // KYC public_inputs: commitment (32 bytes) + issuer_x (32 bytes) + issuer_y (32 bytes)
    // We'll keep commitment but replace issuer_x/issuer_y with zeros (clearly different)
    const kycPublicInputs = fs.readFileSync(path.join(FIXTURES, 'kyc', 'public_inputs'));
    const commitment = kycPublicInputs.slice(0, 32);
    const differentIssuerX = Buffer.alloc(32, 0); // All zeros
    const differentIssuerY = Buffer.alloc(32, 0); // All zeros
    const wrongIssuerInputs = Buffer.concat([commitment, differentIssuerX, differentIssuerY]);
    publishFixture('kyc_wrong_issuer', {
      proof: fs.readFileSync(path.join(FIXTURES, 'kyc', 'proof')),
      vk: fs.readFileSync(path.join(FIXTURES, 'kyc', 'vk')),
      public_inputs: wrongIssuerInputs,
    });
    console.log('  -> fixtures/negative/kyc_wrong_issuer/{proof,public_inputs,vk}');

    // 2. Proof for unmet threshold (income below threshold)
    // This requires running nargo and bb, which we'll document as a manual step
    console.log('2. Proof for unmet threshold (income)...');
    console.log('  -> Manual step: See documentation for generating income_unmet_threshold fixtures');

    // 3. Proof with truncated public inputs (wrong count)
    console.log('3. Proof with truncated public inputs...');
    // KYC public_inputs should be 96 bytes (32 + 32 + 32)
    // Truncate to 64 bytes (missing issuer_y)
    const truncatedInputs = kycPublicInputs.slice(0, 64);
    publishFixture('kyc_truncated_inputs', {
      proof: fs.readFileSync(path.join(FIXTURES, 'kyc', 'proof')),
      vk: fs.readFileSync(path.join(FIXTURES, 'kyc', 'vk')),
      public_inputs: truncatedInputs,
    });
    console.log('  -> fixtures/negative/kyc_truncated_inputs/{proof,public_inputs,vk}');

    // 4. Proof from wrong circuit type (age proof verified against kyc VK)
    console.log('4. Proof from wrong circuit type (age proof with kyc VK)...');
    publishFixture('kyc_wrong_circuit', {
      proof: fs.readFileSync(path.join(FIXTURES, 'age', 'proof')),
      public_inputs: fs.readFileSync(path.join(FIXTURES, 'age', 'public_inputs')),
      vk: fs.readFileSync(path.join(FIXTURES, 'kyc', 'vk')),
    });
    console.log('  -> fixtures/negative/kyc_wrong_circuit/{proof,public_inputs,vk}');

    console.log('done. Negative fixtures generated in', NEGATIVE_FIXTURES);
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main();
}

module.exports = { acquireLock, publishFixture, main };
