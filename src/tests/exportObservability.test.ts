import { describe, it, expect, beforeEach } from 'vitest';
import {
  ExportMetricsRegistry,
  ExportTracer,
  ExportStorage,
  ExportJobQueue,
  ExportWorker,
  AlertManager,
  ExportDashboardService,
  ExportService,
} from '../lib/export';

describe('Export Observability & Monitoring Subsystem', () => {
  let metrics: ExportMetricsRegistry;
  let tracer: ExportTracer;
  let storage: ExportStorage;
  let queue: ExportJobQueue;
  let worker: ExportWorker;
  let alertManager: AlertManager;
  let dashboard: ExportDashboardService;
  let exportService: ExportService;

  beforeEach(() => {
    metrics = new ExportMetricsRegistry();
    tracer = new ExportTracer(100);
    storage = new ExportStorage(metrics, tracer);
    queue = new ExportJobQueue(metrics);
    worker = new ExportWorker(queue, storage, metrics, tracer, {
      slowJobThresholdMs: 100, // low threshold for testing
      batchSize: 20,
    });
    alertManager = new AlertManager(metrics, queue, {
      failureRateThreshold: 0.2, // 20%
      backlogGrowthThreshold: 3,
      slowJobThresholdMs: 100,
      minJobsForFailureRate: 2,
    });
    dashboard = new ExportDashboardService(metrics, tracer, alertManager, queue);
    exportService = new ExportService({
      metrics,
      tracer,
      storage,
      workerOptions: { slowJobThresholdMs: 100, batchSize: 20 },
      alertConfig: { failureRateThreshold: 0.2, backlogGrowthThreshold: 3, slowJobThresholdMs: 100 },
    });
  });

  describe('1. Metrics Instrumentation', () => {
    it('instruments counter, gauge, and histogram metrics', () => {
      // Counters
      metrics.jobsTotal.inc({ status: 'completed', format: 'json' }, 2);
      expect(metrics.jobsTotal.get({ status: 'completed', format: 'json' })).toBe(2);
      expect(metrics.jobsTotal.getTotal()).toBe(2);

      // Gauges
      metrics.queueBacklog.set(5);
      expect(metrics.queueBacklog.get()).toBe(5);
      metrics.queueBacklog.dec();
      expect(metrics.queueBacklog.get()).toBe(4);

      // Histogram
      metrics.jobDurationMs.observe(45);
      metrics.jobDurationMs.observe(120);
      metrics.jobDurationMs.observe(300);

      const stats = metrics.jobDurationMs.getStats();
      expect(stats.count).toBe(3);
      expect(stats.min).toBe(45);
      expect(stats.max).toBe(300);
      expect(stats.avg).toBeGreaterThan(100);
      expect(stats.p95).toBe(300);
    });

    it('exports metrics in standard Prometheus exposition format', () => {
      metrics.jobsTotal.inc({ status: 'completed', format: 'csv' }, 1);
      metrics.rowsExportedTotal.inc({ format: 'csv', status: 'exported' }, 50);
      metrics.queueBacklog.set(2);
      metrics.jobDurationMs.observe(150);

      const prometheusOutput = metrics.toPrometheus();
      expect(prometheusOutput).toContain('# HELP export_jobs_total');
      expect(prometheusOutput).toContain('# TYPE export_jobs_total counter');
      expect(prometheusOutput).toContain('export_jobs_total{format="csv",status="completed"} 1');
      expect(prometheusOutput).toContain('export_rows_total{format="csv",status="exported"} 50');
      expect(prometheusOutput).toContain('export_queue_backlog 2');
      expect(prometheusOutput).toContain('export_job_duration_ms_bucket{le="250"} 1');
    });

    it('produces structured snapshot for dashboard consumption', () => {
      metrics.jobsTotal.inc({ status: 'completed' }, 4);
      metrics.jobsTotal.inc({ status: 'failed' }, 1);
      metrics.errorsTotal.inc({ stage: 'storage', code: 'WRITE_ERROR' }, 1);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.jobs.completed).toBe(4);
      expect(snapshot.jobs.failed).toBe(1);
      expect(snapshot.errors.total).toBe(1);
      expect(snapshot.errors.byStage.storage).toBe(1);
    });
  });

  describe('2. Distributed Tracing for Long-running Jobs', () => {
    it('creates root traces and child spans with timing and attributes', async () => {
      const rootSpan = tracer.startTrace('export.batch_job', { tenant: 'tenant-1' });
      expect(rootSpan.traceId).toBeDefined();

      const childSpan = tracer.startSpan('export.transform', rootSpan, { rows: 100 });
      childSpan.addEvent('transform_started');
      childSpan.end();

      rootSpan.end();

      const trace = tracer.getTrace(rootSpan.traceId);
      expect(trace).toBeDefined();
      expect(trace?.rootSpanName).toBe('export.batch_job');
      expect(trace?.spans.length).toBe(2);
      expect(trace?.status).toBe('ok');
    });

    it('records errors and exceptions in trace context', async () => {
      let caughtError = false;
      try {
        await tracer.withSpan('export.faulty_op', undefined, async (span) => {
          span.setAttribute('attempt', 1);
          throw new Error('Database connection dropped');
        });
      } catch (err: any) {
        caughtError = true;
      }

      expect(caughtError).toBe(true);
      const errorTraces = tracer.getErrorTraces();
      expect(errorTraces.length).toBe(1);
      expect(errorTraces[0].status).toBe('error');
      expect(errorTraces[0].spans[0].statusMessage).toBe('Database connection dropped');
    });

    it('tracks slow traces when job duration exceeds thresholds', async () => {
      const rootSpan = tracer.startTrace('export.long_job');
      // Simulate artificial elapsed time
      rootSpan.durationMs = 250;
      rootSpan.end();

      const slowTraces = tracer.getSlowTraces(100);
      expect(slowTraces.length).toBe(1);
      expect(slowTraces[0].rootSpanName).toBe('export.long_job');
    });
  });

  describe('3. Storage Operations (Encryption, Checksums, Metrics)', () => {
    it('persists artifact with SHA256 checksum and measures latency', async () => {
      const metadata = await storage.saveArtifact('job-1', 'credentials.csv', 'id,wallet\n1,GB123');
      expect(metadata.artifactId).toBeDefined();
      expect(metadata.checksum).toBeDefined();
      expect(metadata.checksum.length).toBe(64);
      expect(metadata.isEncrypted).toBe(false);

      expect(metrics.storageOpsTotal.get({ operation: 'write', status: 'success' })).toBe(1);
      expect(metrics.storageDurationMs.getStats().count).toBe(1);

      const retrieved = await storage.readArtifact(metadata.artifactId);
      expect(retrieved.data.toString('utf8')).toBe('id,wallet\n1,GB123');
      expect(retrieved.metadata.checksum).toBe(metadata.checksum);
    });

    it('encrypts artifact when tenant secret key is provided and verifies round-trip', async () => {
      const tenantKey = 'tenant-secret-encryption-key-7788';
      const metadata = await storage.saveArtifact('job-2', 'export.json', '{"verified":true}', {
        encrypt: true,
        tenantSecretKey: tenantKey,
        keyId: 'k1',
      });

      expect(metadata.isEncrypted).toBe(true);
      expect(metadata.encryptionMeta?.iv).toBeDefined();
      expect(metadata.encryptionMeta?.authTag).toBeDefined();

      const decrypted = await storage.readArtifact(metadata.artifactId, tenantKey);
      expect(decrypted.data.toString('utf8')).toBe('{"verified":true}');
    });

    it('records storage errors and metrics on simulated storage failure', async () => {
      await expect(
        storage.saveArtifact('job-3', 'fail.csv', 'data', { simulateFailure: true })
      ).rejects.toThrow(/Simulated storage write disk failure/);

      expect(metrics.storageOpsTotal.get({ operation: 'write', status: 'failure' })).toBe(1);
      expect(metrics.errorsTotal.get({ stage: 'storage', code: 'WRITE_ERROR' })).toBe(1);
    });
  });

  describe('4. Worker Execution, Job Progress, & Backlog Monitoring', () => {
    it('executes export job successfully and instruments duration and rows', async () => {
      const job = worker.createJob({
        tenantId: 'tenant-stellar-1',
        format: 'json',
        totalRows: 60,
      });

      expect(queue.length).toBe(1);
      expect(metrics.queueBacklog.get()).toBe(1);

      const processedJob = await worker.processJob(job);
      expect(processedJob.status).toBe('completed');
      expect(processedJob.processedRows).toBe(60);
      expect(processedJob.durationMs).toBeGreaterThanOrEqual(0);

      // Verify metrics
      expect(metrics.jobsTotal.get({ status: 'completed', format: 'json' })).toBe(1);
      expect(metrics.rowsExportedTotal.get({ format: 'json', status: 'exported' })).toBe(60);
      expect(metrics.jobDurationMs.getStats().count).toBe(1);
    });

    it('flags slow jobs and updates slow job metrics when SLA breached', async () => {
      const job = worker.createJob({
        tenantId: 'tenant-slow',
        format: 'csv',
        totalRows: 10,
        simulateDelayMs: 120, // exceeds slowJobThresholdMs (100ms)
      });

      const processed = await worker.processJob(job);
      expect(processed.status).toBe('completed');
      expect(processed.durationMs).toBeGreaterThanOrEqual(100);
      expect(metrics.slowJobsTotal.get({ severity: 'warning' })).toBe(1);
    });
  });

  describe('5. Automated Alert Rules & Failure Spike Simulation', () => {
    it('triggers JOB_FAILURE_SPIKE alert when job error rate spikes', async () => {
      // 1 success
      const jobSuccess = worker.createJob({ tenantId: 't1', format: 'csv', totalRows: 10 });
      await worker.processJob(jobSuccess);

      // 2 failures
      const jobFail1 = worker.createJob({ tenantId: 't1', format: 'csv', totalRows: 10, simulateErrorAtStage: 'process' });
      await worker.processJob(jobFail1);

      const jobFail2 = worker.createJob({ tenantId: 't1', format: 'csv', totalRows: 10, simulateErrorAtStage: 'storage' });
      await worker.processJob(jobFail2);

      // Failure rate: 2/3 = 66.7% (threshold: 20%)
      const activeAlerts = alertManager.evaluate();
      const failureAlert = activeAlerts.find((a) => a.id === 'JOB_FAILURE_SPIKE');

      expect(failureAlert).toBeDefined();
      expect(failureAlert?.status).toBe('FIRING');
      expect(failureAlert?.severity).toBe('critical');
      expect(failureAlert?.summary).toContain('Export job failure rate');
    });

    it('triggers QUEUE_BACKLOG_GROWTH alert when queue backlog exceeds capacity', () => {
      // Enqueue 4 jobs (threshold: 3)
      for (let i = 0; i < 4; i++) {
        worker.createJob({ tenantId: 'tenant-backlog', format: 'json', totalRows: 10 });
      }

      expect(queue.length).toBe(4);
      const activeAlerts = alertManager.evaluate();
      const backlogAlert = activeAlerts.find((a) => a.id === 'QUEUE_BACKLOG_GROWTH');

      expect(backlogAlert).toBeDefined();
      expect(backlogAlert?.status).toBe('FIRING');
      expect(backlogAlert?.severity).toBe('warning');
      expect(backlogAlert?.summary).toContain('Export queue backlog is high');
    });

    it('triggers SLOW_JOB_SLA_BREACH alert when slow jobs detected', async () => {
      const slowJob = worker.createJob({
        tenantId: 'tenant-slow',
        format: 'json',
        totalRows: 10,
        simulateDelayMs: 120,
      });

      await worker.processJob(slowJob);

      const activeAlerts = alertManager.evaluate();
      const slowAlert = activeAlerts.find((a) => a.id === 'SLOW_JOB_SLA_BREACH');

      expect(slowAlert).toBeDefined();
      expect(slowAlert?.status).toBe('FIRING');
      expect(slowAlert?.summary).toContain('slow export jobs');
    });

    it('triggers STORAGE_FAILURE_RATE alert on storage operation errors', async () => {
      const job = worker.createJob({
        tenantId: 'tenant-storage-fail',
        format: 'csv',
        totalRows: 10,
        simulateErrorAtStage: 'storage',
      });

      await worker.processJob(job);

      const activeAlerts = alertManager.evaluate();
      const storageAlert = activeAlerts.find((a) => a.id === 'STORAGE_FAILURE_RATE');

      expect(storageAlert).toBeDefined();
      expect(storageAlert?.status).toBe('FIRING');
      expect(storageAlert?.severity).toBe('critical');
    });

    it('dispatches notifications to registered listeners on alert state transitions', () => {
      const notifications: any[] = [];
      alertManager.addListener((notif) => notifications.push(notif));

      // Trigger backlog alert
      for (let i = 0; i < 4; i++) {
        worker.createJob({ tenantId: 't-notif', format: 'csv' });
      }
      alertManager.evaluate();

      expect(notifications.length).toBe(1);
      expect(notifications[0].status).toBe('FIRING');
      expect(notifications[0].alertId).toBe('QUEUE_BACKLOG_GROWTH');

      // Clear queue and re-evaluate -> alert resolves
      queue.clear();
      alertManager.evaluate();

      expect(notifications.length).toBe(2);
      expect(notifications[1].status).toBe('OK');
      expect(notifications[1].summary).toContain('RESOLVED');
    });
  });

  describe('6. Dashboard & Health Status', () => {
    it('aggregates dashboard telemetry and determines system health', async () => {
      const job = worker.createJob({ tenantId: 't-dash', format: 'json', totalRows: 50 });
      await worker.processJob(job);

      const dashData = dashboard.getDashboardData();
      expect(dashData.status).toBe('HEALTHY');
      expect(dashData.summary.completedJobs).toBe(1);
      expect(dashData.summary.totalRowsExported).toBe(50);
      expect(dashData.summary.successRate).toBe(100);
      expect(dashData.latency.jobP95Ms).toBeDefined();
      expect(dashData.recentTraces.length).toBeGreaterThan(0);
    });

    it('renders responsive HTML dashboard with KPI cards and alert banners', () => {
      const html = dashboard.renderDashboardHtml();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Export Jobs Observability');
      expect(html).toContain('Active Alerts');
      expect(html).toContain('Success Rate');
      expect(html).toContain('Recent Job Traces');
    });
  });

  describe('7. End-to-End Synthetic Monitoring Probe', () => {
    it('runs synthetic probe transaction to verify healthy export pipeline', async () => {
      const probeResult = await exportService.runSyntheticMonitoringProbe();

      expect(probeResult.success).toBe(true);
      expect(probeResult.durationMs).toBeGreaterThanOrEqual(0);
      expect(probeResult.jobId).toBeDefined();
      expect(probeResult.traceId).toBeDefined();
      expect(probeResult.activeAlerts.length).toBe(0);

      const metricsProm = exportService.getMetricsPrometheus();
      expect(metricsProm).toContain('export_jobs_total');
      expect(metricsProm).toContain('synthetic_probe_runner');
    });
  });
});
