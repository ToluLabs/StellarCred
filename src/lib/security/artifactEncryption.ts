import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

export interface EncryptedResult {
  encryptedData: string;
  iv: string;
  authTag: string;
  keyId: string;
}

export function encryptArtifact(data: string | Buffer, tenantSecretKey: string, keyId: string = 'default-tenant-key'): EncryptedResult {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(tenantSecretKey).digest();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const encrypted = Buffer.concat([cipher.update(bufferData), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedData: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    keyId,
  };
}

export function decryptArtifact(encryptedPayload: EncryptedResult, tenantSecretKey: string): Buffer {
  const key = crypto.createHash('sha256').update(tenantSecretKey).digest();
  const iv = Buffer.from(encryptedPayload.iv, 'base64');
  const authTag = Buffer.from(encryptedPayload.authTag, 'base64');
  const encryptedData = Buffer.from(encryptedPayload.encryptedData, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted;
}
