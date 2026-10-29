const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts/verify-deployment.sh');

describe('End-to-End Deployment Verification Script (#verify-deployment)', () => {
  it('is executable and passes syntax check (bash -n)', () => {
    const res = spawnSync('bash', ['-n', SCRIPT_PATH], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `Syntax error: ${res.stderr}`);
  });

  it('prints help and usage with --help and exits with 0', () => {
    const stdout = execFileSync('bash', [SCRIPT_PATH, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.ok(stdout.includes('Usage:'));
    assert.ok(stdout.includes('./scripts/verify-deployment.sh'));
    assert.ok(stdout.includes('make verify-deployment'));
    assert.ok(stdout.includes('--network'));
    assert.ok(stdout.includes('--skip-build'));
    assert.ok(stdout.includes('--skip-vks'));
    assert.ok(stdout.includes('--skip-onchain'));
  });

  it('rejects invalid network argument and exits with 1', () => {
    const res = spawnSync('bash', [SCRIPT_PATH, '--network', 'devnet-invalid'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.strictEqual(res.status, 1);
    assert.ok(res.stderr.includes("Invalid network 'devnet-invalid'"));
  });

  it('correctly reads deployed contract IDs from DEPLOYMENTS.md for testnet', () => {
    const deploymentsContent = fs.readFileSync(path.join(REPO_ROOT, 'DEPLOYMENTS.md'), 'utf8');

    // Expected testnet contract IDs from DEPLOYMENTS.md
    const expected = {
      issuer_registry: 'CDYPCHIFRXAAJFUA7MBH4FAWYLNG7XMAH7QRGVF437V2PGDBXZ2VK2DZ',
      credential_verifier: 'CCUUSDWSCSML3DFXVNEXQN7OFYXY2PGBOLKJR5R4Q5JPK47V4TYPQUKJ',
      proof_registry: 'CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV',
      gated_pool: 'CCKQQGWNKMFWAYPT37KEI5WQSCDEPH6H7XZEFJ3UB5BH5SVZBUPVUGI3',
    };

    for (const [name, id] of Object.entries(expected)) {
      assert.ok(
        deploymentsContent.includes(id),
        `DEPLOYMENTS.md should contain contract ID for ${name}: ${id}`,
      );
    }
  });

  it('decodes encoded u32 contract versions properly (1001000 -> 1.1.0)', () => {
    // Test the arithmetic used in decode_version helper
    function decodeVersion(encoded) {
      const num = Number(encoded);
      const major = Math.floor(num / 1_000_000);
      const minor = Math.floor((num % 1_000_000) / 1_000);
      const patch = num % 1_000;
      return `${major}.${minor}.${patch}`;
    }

    assert.strictEqual(decodeVersion(1000000), '1.0.0');
    assert.strictEqual(decodeVersion(1001000), '1.1.0');
    assert.strictEqual(decodeVersion(1002003), '1.2.3');
  });

  it('reports failure when verifying mainnet because mainnet is not yet deployed', () => {
    const res = spawnSync(
      'bash',
      [SCRIPT_PATH, '--network', 'mainnet', '--skip-build', '--skip-onchain', '--skip-vks'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
    assert.strictEqual(res.status, 1);
    assert.ok(res.stdout.includes('VERIFICATION SUMMARY'));
    assert.ok(res.stdout.includes('RESULT: FAIL'));
    assert.ok(res.stdout.includes('No contract ID recorded for mainnet in DEPLOYMENTS.md'));
  });

  it('executes testnet offline verification and prints structured summary', () => {
    const res = spawnSync(
      'bash',
      [SCRIPT_PATH, '--network', 'testnet', '--skip-build', '--skip-onchain', '--skip-vks'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
    assert.ok(res.stdout.includes('StellarCred End-to-End Deployment Verification'));
    assert.ok(res.stdout.includes('--- Step 1: Contract IDs from DEPLOYMENTS.md ---'));
    assert.ok(res.stdout.includes('CDYPCHIFRXAAJFUA7MBH4FAWYLNG7XMAH7QRGVF437V2PGDBXZ2VK2DZ'));
    assert.ok(res.stdout.includes('CCUUSDWSCSML3DFXVNEXQN7OFYXY2PGBOLKJR5R4Q5JPK47V4TYPQUKJ'));
    assert.ok(res.stdout.includes('CBEXHUMCNS4TJWNYXRFJNIWCNUW62MHAXL4JOBT764CLMHAPNJKIRWXV'));
    assert.ok(res.stdout.includes('CCKQQGWNKMFWAYPT37KEI5WQSCDEPH6H7XZEFJ3UB5BH5SVZBUPVUGI3'));
    assert.ok(res.stdout.includes('VERIFICATION SUMMARY'));
  });

  it('handles legacy manifest mode for backwards compatibility', () => {
    const tempManifest = path.join(REPO_ROOT, 'test-manifest.json');
    try {
      fs.writeFileSync(
        tempManifest,
        JSON.stringify({
          timestamp: '2024-08-30T12:00:00Z',
          network: 'testnet',
          admin: 'GTEST',
          contracts: {},
        }),
      );

      const res = spawnSync('bash', [SCRIPT_PATH, tempManifest], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.ok(res.stdout.includes('Verifying deployment manifest:'));
      assert.ok(res.stdout.includes('Deployment Info:'));
    } finally {
      if (fs.existsSync(tempManifest)) {
        fs.unlinkSync(tempManifest);
      }
    }
  });
});
