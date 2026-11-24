import crypto from 'crypto';

export interface DownloadTokenPayload {
  artifactId: string;
  tenantId: string;
  expiresAt: number;
}

const SIGNING_SECRET = process.env.DOWNLOAD_SIGNING_SECRET || 'stellarcred-secure-download-secret';

export function generateSecureDownloadUrl(artifactId: string, tenantId: string, expiresInSeconds: number = 300, baseUrl: string = 'https://api.stellarcred.io'): { url: string; token: string; expiresAt: number } {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const payload: DownloadTokenPayload = { artifactId, tenantId, expiresAt };
  
  const payloadString = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SIGNING_SECRET).update(payloadString).digest('base64url');
  
  const token = `${payloadString}.${signature}`;
  const url = `${baseUrl}/api/v1/downloads/${artifactId}?token=${token}`;

  return { url, token, expiresAt };
}

export function verifySecureDownloadToken(token: string): { isValid: boolean; payload?: DownloadTokenPayload; error?: string } {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) {
      return { isValid: false, error: 'Invalid token structure' };
    }

    const [payloadString, signature] = parts;
    const expectedSignature = crypto.createHmac('sha256', SIGNING_SECRET).update(payloadString).digest('base64url');

    if (signature !== expectedSignature) {
      return { isValid: false, error: 'Invalid token signature' };
    }

    const payload: DownloadTokenPayload = JSON.parse(Buffer.from(payloadString, 'base64url').toString('utf8'));

    if (Date.now() > payload.expiresAt) {
      return { isValid: false, error: 'Token has expired' };
    }

    return { isValid: true, payload };
  } catch (err: any) {
    return { isValid: false, error: err.message || 'Verification failed' };
  }
}
