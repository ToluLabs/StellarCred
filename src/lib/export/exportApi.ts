/**
 * Export Observability - Unified Export Service & API
 *
 * Coordinates export requests, queue processing, metrics collection,
 * distributed tracing, alert evaluation, and synthetic health probes.
 */

import { ExportMetricsRegistry, defaultMetrics } from './metrics';
import { ExportTracer, defaultTracer, TraceRecord } from './tracer';
import { ExportStorage, defaultStorage } from './storage';
import { ExportJobQueue, ExportWorker, ExportJob, ExportJobRequest, WorkerOptions } from './worker';
import { AlertManager, ActiveAlert, AlertManagerConfig } from './alerts';
import { ExportDashboardService, DashboardData } from './dashboard';

export interface ExportServiceOptions {
  metrics?: ExportMetricsRegistry;
  tracer?: ExportTracer;
  storage?: ExportStorage;
  workerOptions?: WorkerOptions;
  alertConfig?: AlertManagerConfig;
}

export class ExportService {
  public readonly metrics: ExportMetricsRegistry;
  public readonly tracer: ExportTracer;
  public readonly storage: ExportStorage;
  public readonly queue: ExportJobQueue;
  public readonly worker: ExportWorker;
  public readonly alertManager: AlertManager;
  public readonly dashboard: ExportDashboardService;

  constructor(options: ExportServiceOptions = {}) {
    this.metrics = options.metrics || new ExportMetricsRegistry();
    this.tracer = options.tracer || new ExportTracer();
    this.storage = options.storage || new ExportStorage(this.metrics, this.tracer);
    this.queue = new ExportJobQueue(this.metrics);
    this.worker = new ExportWorker(
      this.queue,
      this.storage,
      this.metrics,
      this.tracer,
      options.workerOptions
    );
    this.alertManager = new AlertManager(this.metrics, this.queue, options.alertConfig);
    this.dashboard = new ExportDashboardService(
      this.metrics,
      this.tracer,
      this.alertManager,
      this.queue
    );
  }

  /**
   * Submits a new export job through the API.
   */
  submitJob(request: ExportJobRequest): ExportJob {
    return this.worker.createJob(request);
  }

  /**
   * Retrieves an export job by ID.
   */
  getJob(jobId: string): ExportJob | undefined {
    return this.queue.get(jobId);
  }

  /**
   * Processes all pending queued jobs.
   */
  async processQueue(tenantSecretKey?: string): Promise<ExportJob[]> {
    const processed = await this.worker.processAll(tenantSecretKey);
    this.alertManager.evaluate();
    return processed;
  }

  /**
   * Returns Prometheus metrics text for scraping (/metrics endpoint).
   */
  getMetricsPrometheus(): string {
    return this.metrics.toPrometheus();
  }

  /**
   * Returns JSON snapshot of all metrics.
   */
  getMetricsSnapshot() {
    return this.metrics.getSnapshot();
  }

  /**
   * Retrieves traces with optional filtering.
   */
  getTraces(filter?: { slowOnly?: boolean; errorOnly?: boolean; minDurationMs?: number; limit?: number }): TraceRecord[] {
    const limit = filter?.limit || 50;
    if (filter?.errorOnly) {
      return this.tracer.getErrorTraces(limit);
    }
    if (filter?.slowOnly || filter?.minDurationMs) {
      return this.tracer.getSlowTraces(filter.minDurationMs || this.worker.slowJobThresholdMs, limit);
    }
    return this.tracer.getRecentTraces(limit);
  }

  /**
   * Returns structured dashboard data.
   */
  getDashboardData(): DashboardData {
    return this.dashboard.getDashboardData();
  }

  /**
   * Renders the HTML observability dashboard.
   */
  renderDashboardHtml(): string {
    return this.dashboard.renderDashboardHtml();
  }

  /**
   * Evaluates alerts and returns active alerts.
   */
  evaluateAlerts(): ActiveAlert[] {
    return this.alertManager.evaluate();
  }

  /**
   * Synthetic Monitoring:
   * Executes synthetic export probe transactions to verify end-to-end subsystem health
   * and detect latency or failure anomalies early.
   */
  async runSyntheticMonitoringProbe(): Promise<{
    success: boolean;
    durationMs: number;
    jobId: string;
    traceId: string;
    activeAlerts: ActiveAlert[];
  }> {
    const start = Date.now();
    const synthJob = this.submitJob({
      tenantId: 'synthetic_probe_runner',
      format: 'json',
      totalRows: 10,
    });

    const result = await this.worker.processJob(synthJob);
    const durationMs = Date.now() - start;
    const activeAlerts = this.alertManager.evaluate();

    return {
      success: result.status === 'completed',
      durationMs,
      jobId: result.id,
      traceId: result.traceId,
      activeAlerts,
    };
  }

  /**
   * Resets all internal state for testing.
   */
  reset(): void {
    this.metrics.reset();
    this.tracer.clear();
    this.storage.clear();
    this.queue.clear();
    this.alertManager.reset();
  }
}
