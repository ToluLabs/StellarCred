import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  createExportJob,
  getExportJob,
  listUserExportJobs,
  getAllowedScopes,
  getExportArtifact,
} from '../export-jobs';
import {
  generateSecureDownloadUrl,
  verifySecureDownloadToken,
} from '../security/secureDownload';

describe('Issue #789: Export Data Backend & Authorization', () => {
  const testUser = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2';

  describe('Scope Authorization', () => {
    it('returns only standard scopes for normal users', () => {
      const scopes = getAllowedScopes(false);
      expect(scopes).toContain('credentials');
      expect(scopes).toContain('proofs');
      expect(scopes).toContain('activity');
      expect(scopes).toContain('full');
      expect(scopes).not.toContain('admin_audit');
    });

    it('returns admin scopes when user is admin', () => {
      const scopes = getAllowedScopes(true);
      expect(scopes).toContain('admin_audit');
      expect(scopes).toContain('credentials');
    });

    it('rejects unauthorized scope creation for normal users', async () => {
      await expect(
        createExportJob({
          userAddress: testUser,
          scope: 'admin_audit',
          format: 'json',
          isAdmin: false,
        })
      ).rejects.toThrow(/Unauthorized scope/);
    });

    it('allows admin_audit scope when isAdmin is true', async () => {
      const job = await createExportJob({
        userAddress: testUser,
        scope: 'admin_audit',
        format: 'json',
        isAdmin: true,
      });
      expect(job.id).toBeDefined();
      expect(job.scope).toBe('admin_audit');
    });
  });

  describe('Job Lifecycle & Async Processing', () => {
    it('creates a job in pending status and transitions to ready', async () => {
      const job = await createExportJob({
        userAddress: testUser,
        scope: 'credentials',
        format: 'json',
        isAdmin: false,
      });

      expect(job.status).toBe('pending');
      expect(job.progress).toBe(0);

      // Wait for async processing simulation to complete
      await new Promise((resolve) => setTimeout(resolve, 1200));

      const updated = await getExportJob(job.id);
      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('ready');
      expect(updated?.progress).toBe(100);
      expect(updated?.downloadUrl).toBeDefined();
      expect(updated?.expiresAt).toBeDefined();
      expect(updated?.downloadToken).toBeDefined();

      // Verify artifact content
      const artifact = await getExportArtifact(job.id);
      expect(artifact).not.toBeNull();
      expect(artifact?.format).toBe('json');
      const parsed = JSON.parse(artifact!.content);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.entries.length).toBeGreaterThan(0);
    });

    it('supports CSV format exports', async () => {
      const job = await createExportJob({
        userAddress: testUser,
        scope: 'proofs',
        format: 'csv',
        isAdmin: false,
      });

      await new Promise((resolve) => setTimeout(resolve, 1200));

      const updated = await getExportJob(job.id);
      expect(updated?.status).toBe('ready');
      expect(updated?.format).toBe('csv');

      const artifact = await getExportArtifact(job.id);
      expect(artifact?.format).toBe('csv');
      expect(artifact?.content).toContain('claim_type');
      expect(artifact?.content).toContain('proofs');
    });

    it('lists all jobs created for a specific user', async () => {
      const uniqueUser = 'G' + Math.random().toString(36).substring(2, 15).toUpperCase().padEnd(55, 'A');
      await createExportJob({
        userAddress: uniqueUser,
        scope: 'full',
        format: 'json',
      });

      const list = await listUserExportJobs(uniqueUser);
      expect(list.length).toBe(1);
      expect(list[0].userAddress).toBe(uniqueUser);
      expect(list[0].scope).toBe('full');
    });
  });

  describe('Secure Expiring Download Links', () => {
    it('generates a valid signed token that verifies successfully', () => {
      const artifactId = 'art_test_123';
      const tenantId = 'tenant_main';
      const { url, token, expiresAt } = generateSecureDownloadUrl(
        artifactId,
        tenantId,
        300,
        '',
        'credentials',
        testUser
      );

      expect(url).toContain('/api/export/download?token=');
      expect(token).toBeDefined();
      expect(expiresAt).toBeGreaterThan(Date.now());

      const res = verifySecureDownloadToken(token);
      expect(res.isValid).toBe(true);
      expect(res.payload?.artifactId).toBe(artifactId);
      expect(res.payload?.tenantId).toBe(tenantId);
      expect(res.payload?.scope).toBe('credentials');
    });

    it('rejects expired tokens when TTL is negative', () => {
      const { token } = generateSecureDownloadUrl('art_exp', 'tenant_main', -10);
      const res = verifySecureDownloadToken(token);
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Token has expired');
    });

    it('rejects tampered tokens', () => {
      const { token } = generateSecureDownloadUrl('art_tamper', 'tenant_main', 300);
      const tampered = token.slice(0, -4) + 'abcd';
      const res = verifySecureDownloadToken(tampered);
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Invalid token signature');
    });

    it('rejects missing / empty token', () => {
      expect(verifySecureDownloadToken('').isValid).toBe(false);
      expect(verifySecureDownloadToken('').error).toBe('Missing token');
    });

    it('rejects token with wrong number of parts', () => {
      const res = verifySecureDownloadToken('onlyonepart');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Invalid token structure');
    });

    it('rejects token with three parts', () => {
      const res = verifySecureDownloadToken('a.b.c');
      expect(res.isValid).toBe(false);
      expect(res.error).toBe('Invalid token structure');
    });

    it('rejects token with invalid base64 payload (parse error branch)', () => {
      // Create a valid signature for invalid JSON to exercise the catch branch
      const secret = process.env.DOWNLOAD_SIGNING_SECRET || 'stellarcred-secure-download-secret';
      const badPayload = Buffer.from('not-json!').toString('base64url');
      const sig = crypto.createHmac('sha256', secret).update(badPayload).digest('base64url');
      const res = verifySecureDownloadToken(`${badPayload}.${sig}`);
      expect(res.isValid).toBe(false);
      // Will hit the JSON.parse error → catch branch
    });

    it('generates token without optional scope/userAddress fields', () => {
      const { url, token } = generateSecureDownloadUrl('art_min', 'tenant_min', 300);
      expect(url).toContain('/api/export/download?token=');
      const res = verifySecureDownloadToken(token);
      expect(res.isValid).toBe(true);
      expect(res.payload?.scope).toBeUndefined();
      expect(res.payload?.userAddress).toBeUndefined();
    });

    it('generates token with a custom baseUrl prefix', () => {
      const { url } = generateSecureDownloadUrl('art_base', 'tenant_main', 300, 'https://example.com/');
      expect(url).toMatch(/^https:\/\/example\.com\/api\/export\/download\?token=/);
    });
  });

  describe('Export Job edge cases', () => {
    it('returns null for a non-existent job id', async () => {
      const result = await getExportJob('nonexistent-job-id-xyz');
      expect(result).toBeNull();
    });

    it('returns null artifact for a non-existent job id', async () => {
      const result = await getExportArtifact('nonexistent-artifact-xyz');
      expect(result).toBeNull();
    });

    it('returns empty list for a user with no jobs', async () => {
      const list = await listUserExportJobs('GNOBODYHASTHISADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
      expect(list).toEqual([]);
    });

    it('defaults isAdmin to false when omitted', async () => {
      const job = await createExportJob({
        userAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2',
        scope: 'proofs',
        format: 'json',
      });
      expect(job.id).toBeDefined();
      expect(job.scope).toBe('proofs');
    });
  });
});