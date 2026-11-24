const { describe, it, expect } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { generateChecksum, verifyChecksum } = require('../scripts/export-checksum');

describe('Export Artifact Checksums (#785)', () => {
  it('generates correct SHA256 checksum metadata for test payloads', () => {
    const testFilePath = path.join(__dirname, 'test-export-artifact.json');
    const testData = JSON.stringify({ prompt: 'Hello Stellar', version: '1.0' });
    fs.writeFileSync(testFilePath, testData);

    const metadata = generateChecksum(testFilePath);
    assert.strictEqual(metadata.algorithm, 'SHA256');
    assert.ok(metadata.checksum);
    assert.strictEqual(metadata.artifact, 'test-export-artifact.json');

    const checksumFile = `${testFilePath}.sha256`;
    assert.ok(fs.existsSync(checksumFile));

    const isValid = verifyChecksum(testFilePath, checksumFile);
    assert.strictEqual(isValid, true);

    // Cleanup
    fs.unlinkSync(testFilePath);
    fs.unlinkSync(checksumFile);
  });
});
