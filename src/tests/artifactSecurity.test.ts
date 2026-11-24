import { describe, it, expect } from 'vitest';
import { encryptArtifact, decryptArtifact } from '../lib/security/artifactEncryption';
import { generateSecureDownloadUrl, verifySecureDownloadToken } from '../lib/security/secureDownload';

describe('Issue #786: Artifact Encryption & Secure Download URLs', () => {
  it('encrypts and decrypts export artifacts successfully', () => {
    const secretKey = 'tenant-secret-alpha-123';
    const plainText = 'Export credential batch #9921: Verified';

    const encrypted = encryptArtifact(plainText, secretKey, 'key-tenant-1');
    expect(encrypted.encryptedData).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.authTag).toBeDefined();
    expect(encrypted.keyId).toBe('key-tenant-1');

    const decryptedBuffer = decryptArtifact(encrypted, secretKey);
    expect(decryptedBuffer.toString('utf8')).toBe(plainText);
  });

  it('fails to decrypt with incorrect tenant secret key', () => {
    const secretKey = 'tenant-secret-alpha-123';
    const wrongKey = 'tenant-secret-beta-456';
    const plainText = 'Confidential export data';

    const encrypted = encryptArtifact(plainText, secretKey);
    expect(() => decryptArtifact(encrypted, wrongKey)).toThrow();
  });

  it('generates and verifies short-lived secure download tokens', () => {
    const artifactId = 'art_12345';
    const tenantId = 'tenant_xyz';

    const { url, token } = generateSecureDownloadUrl(artifactId, tenantId, 60);
    expect(url).toContain(artifactId);
    expect(token).toBeDefined();

    const verification = verifySecureDownloadToken(token);
    expect(verification.isValid).toBe(true);
    expect(verification.payload?.artifactId).toBe(artifactId);
    expect(verification.payload?.tenantId).toBe(tenantId);
  });

  it('rejects expired download tokens', () => {
    const artifactId = 'art_expired';
    const tenantId = 'tenant_xyz';
    const { token } = generateSecureDownloadUrl(artifactId, tenantId, -10);

    const verification = verifySecureDownloadToken(token);
    expect(verification.isValid).toBe(false);
    expect(verification.error).toBe('Token has expired');
  });
});
