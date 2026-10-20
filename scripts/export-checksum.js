/**
 * Prompt Hash Stellar - Export Artifact Checksum Generator & Verifier (#785)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function generateChecksum(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Artifact not found: ${filePath}`);
  }
  const fileBuffer = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const checksumPath = `${filePath}.sha256`;
  
  const metadata = {
    artifact: path.basename(filePath),
    algorithm: 'SHA256',
    checksum: hash,
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(checksumPath, JSON.stringify(metadata, null, 2));
  console.log(`[Checksum] Generated ${hash} for ${filePath} -> saved to ${checksumPath}`);
  return metadata;
}

function verifyChecksum(filePath, checksumPath) {
  if (!fs.existsSync(filePath) || !fs.existsSync(checksumPath)) {
    return false;
  }
  const fileBuffer = fs.readFileSync(filePath);
  const currentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  
  const metadata = JSON.parse(fs.readFileSync(checksumPath, 'utf-8'));
  return metadata.checksum === currentHash;
}

module.exports = { generateChecksum, verifyChecksum };

if (require.main === module) {
  const target = process.argv[2];
  if (target) {
    generateChecksum(target);
  } else {
    console.log('Usage: node scripts/export-checksum.js <path-to-artifact>');
  }
}
