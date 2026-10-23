/**
 * Export Observability - Storage Operations
 *
 * Handles artifact persistence, encryption, and checksum verification
 * with detailed metrics and trace instrumentation.
 */

import crypto from 'crypto';
import { ExportMetricsRegistry, defaultMetrics } from './metrics';
import { ExportTracer, Span, defaultTracer } from './tracer';
import { encryptArtifact, decryptArtifact, EncryptedResult } from '../security/artifactEncryption';

export interface StorageOptions {
  encrypt?: boolean;
  tenantSecretKey?: string;
  keyId?: string;
  simulateFailure?: boolean;
  parentSpan?: Span;
}

export interface StoredArtifactMetadata {
  artifactId: string;
  jobId: string;
  filename: string;
  sizeBytes: number;
  checksum: string;
  isEncrypted: boolean;
  encryptionMeta?: {
    iv: string;
    authTag: string;
    keyId: string;
  };
  storedAt: number;
}

export class ExportStorage {
  private metrics: ExportMetricsRegistry;
  private tracer: ExportTracer;
  private storageBackend: Map<string, { buffer: Buffer; metadata: StoredArtifactMetadata }> = new Map();

  constructor(metrics: ExportMetricsRegistry = defaultMetrics, tracer: ExportTracer = defaultTracer) {
    this.metrics = metrics;
    this.tracer = tracer;
  }

  /**
   * Persists an export artifact with optional encryption and SHA256 checksum.
   * Tracks storage operation latency and records metrics.
   */
  async saveArtifact(
    jobId: string,
    filename: string,
    content: string | Buffer,
    options: StorageOptions = {}
  ): Promise<StoredArtifactMetadata> {
    const startTime = Date.now();
    const artifactId = `art_${crypto.randomBytes(8).toString('hex')}`;
    
    // Create span for storage operation
    const storageSpan = options.parentSpan
      ? this.tracer.startSpan('storage.write_artifact', options.parentSpan, { jobId, filename, artifactId })
      : this.tracer.startTrace('storage.write_artifact', { jobId, filename, artifactId });

    try {
      if (options.simulateFailure) {
        throw new Error('Simulated storage write disk failure');
      }

      let payloadBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      let isEncrypted = false;
      let encryptionMeta: StoredArtifactMetadata['encryptionMeta'];

      // Step 1: Encrypt if requested
      if (options.encrypt && options.tenantSecretKey) {
        const encryptSpan = this.tracer.startSpan('storage.encrypt', storageSpan, { keyId: options.keyId || 'default' });
        try {
          const encResult: EncryptedResult = encryptArtifact(
            payloadBuffer,
            options.tenantSecretKey,
            options.keyId || 'export-key'
          );
          payloadBuffer = Buffer.from(encResult.encryptedData, 'base64');
          isEncrypted = true;
          encryptionMeta = {
            iv: encResult.iv,
            authTag: encResult.authTag,
            keyId: encResult.keyId,
          };
          encryptSpan.setStatus('ok');
        } catch (encErr) {
          encryptSpan.recordException(encErr);
          throw encErr;
        } finally {
          encryptSpan.end();
        }
      }

      // Step 2: Compute Checksum
      const checksumSpan = this.tracer.startSpan('storage.checksum', storageSpan);
      let checksum = '';
      try {
        checksum = crypto.createHash('sha256').update(payloadBuffer).digest('hex');
        checksumSpan.setAttribute('checksum', checksum);
        checksumSpan.setStatus('ok');
      } finally {
        checksumSpan.end();
      }

      // Step 3: Write payload
      const metadata: StoredArtifactMetadata = {
        artifactId,
        jobId,
        filename,
        sizeBytes: payloadBuffer.length,
        checksum,
        isEncrypted,
        encryptionMeta,
        storedAt: Date.now(),
      };

      this.storageBackend.set(artifactId, { buffer: payloadBuffer, metadata });

      const durationMs = Date.now() - startTime;
      this.metrics.storageDurationMs.observe(durationMs);
      this.metrics.storageOpsTotal.inc({ operation: 'write', status: 'success' });

      storageSpan.setAttributes({
        sizeBytes: metadata.sizeBytes,
        isEncrypted,
        durationMs,
      });
      storageSpan.setStatus('ok');

      return metadata;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      this.metrics.storageDurationMs.observe(durationMs);
      this.metrics.storageOpsTotal.inc({ operation: 'write', status: 'failure' });
      this.metrics.errorsTotal.inc({ stage: 'storage', code: 'WRITE_ERROR' });

      storageSpan.recordException(err);
      throw err;
    } finally {
      storageSpan.end();
    }
  }

  /**
   * Retrieves and optionally decrypts an export artifact.
   */
  async readArtifact(
    artifactId: string,
    tenantSecretKey?: string,
    parentSpan?: Span
  ): Promise<{ data: Buffer; metadata: StoredArtifactMetadata }> {
    const startTime = Date.now();
    const readSpan = parentSpan
      ? this.tracer.startSpan('storage.read_artifact', parentSpan, { artifactId })
      : this.tracer.startTrace('storage.read_artifact', { artifactId });

    try {
      const entry = this.storageBackend.get(artifactId);
      if (!entry) {
        throw new Error(`Artifact ${artifactId} not found in storage`);
      }

      let data = entry.buffer;

      // Verify checksum
      const currentChecksum = crypto.createHash('sha256').update(data).digest('hex');
      if (currentChecksum !== entry.metadata.checksum) {
        throw new Error(`Artifact integrity verification failed: checksum mismatch`);
      }

      // Decrypt if stored encrypted
      if (entry.metadata.isEncrypted && entry.metadata.encryptionMeta) {
        if (!tenantSecretKey) {
          throw new Error('Tenant secret key required to decrypt encrypted artifact');
        }
        const decryptSpan = this.tracer.startSpan('storage.decrypt', readSpan);
        try {
          const payload: EncryptedResult = {
            encryptedData: data.toString('base64'),
            iv: entry.metadata.encryptionMeta.iv,
            authTag: entry.metadata.encryptionMeta.authTag,
            keyId: entry.metadata.encryptionMeta.keyId,
          };
          data = decryptArtifact(payload, tenantSecretKey);
          decryptSpan.setStatus('ok');
        } catch (decErr) {
          decryptSpan.recordException(decErr);
          throw decErr;
        } finally {
          decryptSpan.end();
        }
      }

      const durationMs = Date.now() - startTime;
      this.metrics.storageDurationMs.observe(durationMs);
      this.metrics.storageOpsTotal.inc({ operation: 'read', status: 'success' });
      readSpan.setStatus('ok');

      return { data, metadata: entry.metadata };
    } catch (err) {
      this.metrics.storageOpsTotal.inc({ operation: 'read', status: 'failure' });
      this.metrics.errorsTotal.inc({ stage: 'storage', code: 'READ_ERROR' });
      readSpan.recordException(err);
      throw err;
    } finally {
      readSpan.end();
    }
  }

  getArtifactCount(): number {
    return this.storageBackend.size;
  }

  clear(): void {
    this.storageBackend.clear();
  }
}

export const defaultStorage = new ExportStorage();
