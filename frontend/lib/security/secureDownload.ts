import crypto from 'crypto';

export interface DownloadTokenPayload {
  artifactId: string;
  tenantId: string;
  expiresAt: number;
  scope?: string;
  userAddress?: string;
}

const SIGNING_SECRET = process.env.DOWNLOAD_SIGNING_SECRET || 'stellarcred-secure-download-secret';

/**
 * Generates a signed, expiring secure download token and URL for export artifacts.
 */
export function generateSecureDownloadUrl(
  artifactId: string,
  tenantId: string,
  expiresInSeconds: number = 300,
  baseUrl: string = '',
  scope?: string,
  userAddress?: string
): { url: string; token: string; expiresAt: number } {
  const expiresAt = Date.now() + expiresInSeconds * 1000;
  const payload: DownloadTokenPayload = {
    artifactId,
    tenantId,
    expiresAt,
    ...(scope ? { scope } : {}),
    ...(userAddress ? { userAddress } : {}),
  };

  const payloadString = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SIGNING_SECRET).update(payloadString).digest('base64url');

  const token = `${payloadString}.${signature}`;
  const prefix = baseUrl.replace(/\/+$/, '');
  const url = `${prefix}/api/export/download?token=${encodeURIComponent(token)}`;

  return { url, token, expiresAt };
}

/**
 * Validates a secure download token, verifying cryptographic signature and expiration.
 */
export function verifySecureDownloadToken(token: string): {
  isValid: boolean;
  payload?: DownloadTokenPayload;
  error?: string;
} {
  try {
    if (!token || typeof token !== 'string') {
      return { isValid: false, error: 'Missing token' };
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return { isValid: false, error: 'Invalid token structure' };
    }

    const [payloadString, signature] = parts;
    const expectedSignature = crypto.createHmac('sha256', SIGNING_SECRET).update(payloadString).digest('base64url');

    // Constant-time compare
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { isValid: false, error: 'Invalid token signature' };
    }

    const payload: DownloadTokenPayload = JSON.parse(
      Buffer.from(payloadString, 'base64url').toString('utf8')
    );

    if (Date.now() > payload.expiresAt) {
      return { isValid: false, payload, error: 'Token has expired' };
    }

    return { isValid: true, payload };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    return { isValid: false, error: message };
  }
}
