/**
 * Export Observability - Job Queue & Worker Processing
 *
 * Implements job queueing, batch worker processing, long-running job tracing,
 * slow job detection, and metrics collection.
 */

import crypto from 'crypto';
import { ExportMetricsRegistry, defaultMetrics } from './metrics';
import { ExportTracer, Span, defaultTracer } from './tracer';
import { ExportStorage, defaultStorage, StoredArtifactMetadata } from './storage';

export type ExportFormat = 'csv' | 'json';
export type ExportStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface ExportJobRequest {
  tenantId: string;
  format: ExportFormat;
  resourceType?: string;
  totalRows?: number;
  encrypt?: boolean;
  tenantSecretKey?: string;
  simulateDelayMs?: number;
  simulateErrorAtStage?: 'fetch' | 'process' | 'storage';
}

export interface ExportJob {
  id: string;
  tenantId: string;
  format: ExportFormat;
  resourceType: string;
  status: ExportStatus;
  totalRows: number;
  processedRows: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  traceId: string;
  error?: string;
  artifactMetadata?: StoredArtifactMetadata;
  simulateDelayMs?: number;
  simulateErrorAtStage?: 'fetch' | 'process' | 'storage';
}

export class ExportJobQueue {
  private queue: ExportJob[] = [];
  private jobIndex: Map<string, ExportJob> = new Map();
  private metrics: ExportMetricsRegistry;

  constructor(metrics: ExportMetricsRegistry = defaultMetrics) {
    this.metrics = metrics;
  }

  enqueue(job: ExportJob): void {
    this.queue.push(job);
    this.jobIndex.set(job.id, job);
    this.metrics.queueBacklog.set(this.queue.length);
  }

  dequeue(): ExportJob | undefined {
    const job = this.queue.shift();
    this.metrics.queueBacklog.set(this.queue.length);
    return job;
  }

  get(jobId: string): ExportJob | undefined {
    return this.jobIndex.get(jobId);
  }

  getAll(): ExportJob[] {
    return Array.from(this.jobIndex.values());
  }

  get length(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
    this.jobIndex.clear();
    this.metrics.queueBacklog.set(0);
  }
}

export interface WorkerOptions {
  slowJobThresholdMs?: number;
  batchSize?: number;
  concurrency?: number;
}

export class ExportWorker {
  public readonly slowJobThresholdMs: number;
  public readonly batchSize: number;
  private queue: ExportJobQueue;
  private storage: ExportStorage;
  private metrics: ExportMetricsRegistry;
  private tracer: ExportTracer;
  private isRunning = false;

  constructor(
    queue: ExportJobQueue,
    storage: ExportStorage = defaultStorage,
    metrics: ExportMetricsRegistry = defaultMetrics,
    tracer: ExportTracer = defaultTracer,
    options: WorkerOptions = {}
  ) {
    this.queue = queue;
    this.storage = storage;
    this.metrics = metrics;
    this.tracer = tracer;
    this.slowJobThresholdMs = options.slowJobThresholdMs || 1000;
    this.batchSize = options.batchSize || 100;
  }

  /**
   * Enqueues a new export job and returns the job descriptor.
   */
  createJob(req: ExportJobRequest): ExportJob {
    const id = `job_${crypto.randomBytes(8).toString('hex')}`;
    const rootSpan = this.tracer.startTrace('export.job_lifecycle', {
      jobId: id,
      tenantId: req.tenantId,
      format: req.format,
      totalRows: req.totalRows || 100,
    });

    const job: ExportJob = {
      id,
      tenantId: req.tenantId,
      format: req.format,
      resourceType: req.resourceType || 'credentials',
      status: 'queued',
      totalRows: req.totalRows || 100,
      processedRows: 0,
      createdAt: Date.now(),
      traceId: rootSpan.traceId,
      simulateDelayMs: req.simulateDelayMs,
      simulateErrorAtStage: req.simulateErrorAtStage,
    };

    rootSpan.addEvent('job_enqueued', { queuePosition: this.queue.length + 1 });
    rootSpan.end();

    this.queue.enqueue(job);
    return job;
  }

  /**
   * Processes a single job immediately (useful for worker loops or direct test execution).
   */
  async processJob(job: ExportJob, tenantSecretKey?: string): Promise<ExportJob> {
    const jobStartTime = Date.now();
    job.startedAt = jobStartTime;
    job.status = 'processing';
    this.metrics.activeWorkers.inc();

    // Start execution span associated with the job's trace
    const executionSpan = this.tracer.startTrace('export.job_execution', {
      jobId: job.id,
      tenantId: job.tenantId,
      format: job.format,
      totalRows: job.totalRows,
    });

    try {
      executionSpan.addEvent('worker_started');

      if (job.simulateErrorAtStage === 'fetch') {
        throw new Error('Simulated upstream data fetch failure');
      }

      // Simulate long-running processing if requested
      if (job.simulateDelayMs && job.simulateDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, job.simulateDelayMs));
      }

      // Stage 1: Process records in batches with child span
      const processSpan = this.tracer.startSpan('worker.process_records', executionSpan);
      let exportedPayload = '';
      try {
        const rowsToProcess = job.totalRows;
        let generatedRecords: any[] = [];

        for (let i = 0; i < rowsToProcess; i++) {
          generatedRecords.push({
            id: `row_${i + 1}`,
            tenant: job.tenantId,
            resource: job.resourceType,
            timestamp: new Date().toISOString(),
            status: 'verified',
          });

          // Simulate batch milestones
          if ((i + 1) % this.batchSize === 0 || i === rowsToProcess - 1) {
            job.processedRows = i + 1;
            this.metrics.rowsExportedTotal.inc({ format: job.format, status: 'exported', tenant: job.tenantId }, generatedRecords.length);
            processSpan.addEvent('batch_completed', { rows: job.processedRows });
            generatedRecords = [];
          }
        }

        if (job.simulateErrorAtStage === 'process') {
          throw new Error('Simulated processing transform error');
        }

        // Format payload
        if (job.format === 'json') {
          exportedPayload = JSON.stringify({
            jobId: job.id,
            tenantId: job.tenantId,
            exportedAt: new Date().toISOString(),
            rowCount: job.totalRows,
          }, null, 2);
        } else {
          exportedPayload = `id,tenant,resource,timestamp,status\n` +
            `row_1,${job.tenantId},${job.resourceType},${new Date().toISOString()},verified\n`;
        }

        processSpan.setAttributes({ processedRows: job.processedRows });
        processSpan.setStatus('ok');
      } catch (procErr) {
        processSpan.recordException(procErr);
        throw procErr;
      } finally {
        processSpan.end();
      }

      // Stage 2: Store artifact via instrumented storage operations
      const filename = `export-${job.id}.${job.format}`;
      const artifactMeta = await this.storage.saveArtifact(job.id, filename, exportedPayload, {
        encrypt: !!tenantSecretKey,
        tenantSecretKey,
        simulateFailure: job.simulateErrorAtStage === 'storage',
        parentSpan: executionSpan,
      });

      job.artifactMetadata = artifactMeta;
      job.completedAt = Date.now();
      job.durationMs = job.completedAt - jobStartTime;
      job.status = 'completed';

      // Record metrics
      this.metrics.jobDurationMs.observe(job.durationMs);
      this.metrics.jobsTotal.inc({ status: 'completed', format: job.format, tenant: job.tenantId });

      // Slow job check
      if (job.durationMs >= this.slowJobThresholdMs) {
        this.metrics.slowJobsTotal.inc({ severity: 'warning' });
        executionSpan.setAttribute('slow_job', true);
        executionSpan.addEvent('slow_job_threshold_exceeded', {
          durationMs: job.durationMs,
          thresholdMs: this.slowJobThresholdMs,
        });
      }

      executionSpan.setAttributes({
        durationMs: job.durationMs,
        rowsExported: job.processedRows,
        artifactId: artifactMeta.artifactId,
      });
      executionSpan.setStatus('ok');

      return job;
    } catch (err: any) {
      job.completedAt = Date.now();
      job.durationMs = job.completedAt - jobStartTime;
      job.status = 'failed';
      job.error = err.message || 'Worker execution failed';

      this.metrics.jobDurationMs.observe(job.durationMs);
      this.metrics.jobsTotal.inc({ status: 'failed', format: job.format, tenant: job.tenantId });
      this.metrics.errorsTotal.inc({ stage: 'worker', code: 'EXECUTION_FAILED' });

      executionSpan.recordException(err);
      return job;
    } finally {
      this.metrics.activeWorkers.dec();
      executionSpan.end();
    }
  }

  /**
   * Drains and processes all pending jobs in the queue.
   */
  async processAll(tenantSecretKey?: string): Promise<ExportJob[]> {
    const processed: ExportJob[] = [];
    while (this.queue.length > 0) {
      const job = this.queue.dequeue();
      if (job) {
        const result = await this.processJob(job, tenantSecretKey);
        processed.push(result);
      }
    }
    return processed;
  }
}
