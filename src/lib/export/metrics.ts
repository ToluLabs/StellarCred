/**
 * Export Observability - Metrics Collection & Registry
 *
 * Provides Prometheus-compatible counters, gauges, and histograms
 * to instrument export API requests, background workers, and storage operations.
 */

export interface MetricLabels {
  [key: string]: string | number;
}

function serializeLabels(labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const entries = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`);
  return `{${entries.join(',')}}`;
}

export class Counter {
  private values: Map<string, number> = new Map();
  public readonly name: string;
  public readonly help: string;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels?: MetricLabels, value = 1): void {
    if (value < 0) throw new Error('Counter increment value must be non-negative');
    const key = serializeLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  get(labels?: MetricLabels): number {
    if (!labels || Object.keys(labels).length === 0) {
      return this.getTotal();
    }
    const exact = this.values.get(serializeLabels(labels));
    if (exact !== undefined) return exact;

    // Partial label matching across series
    let sum = 0;
    let found = false;
    for (const [key, val] of this.values.entries()) {
      let matches = true;
      for (const [k, v] of Object.entries(labels)) {
        if (!key.includes(`${k}="${String(v).replace(/"/g, '\\"')}"`)) {
          matches = false;
          break;
        }
      }
      if (matches) {
        sum += val;
        found = true;
      }
    }
    return found ? sum : 0;
  }

  getAll(): Array<{ labels: string; value: number }> {
    return Array.from(this.values.entries()).map(([labels, value]) => ({ labels, value }));
  }

  getTotal(): number {
    let sum = 0;
    for (const val of this.values.values()) {
      sum += val;
    }
    return sum;
  }

  reset(): void {
    this.values.clear();
  }
}

export class Gauge {
  private values: Map<string, number> = new Map();
  public readonly name: string;
  public readonly help: string;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(value: number, labels?: MetricLabels): void {
    this.values.set(serializeLabels(labels), value);
  }

  inc(labels?: MetricLabels, value = 1): void {
    const key = serializeLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  dec(labels?: MetricLabels, value = 1): void {
    const key = serializeLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current - value);
  }

  get(labels?: MetricLabels): number {
    return this.values.get(serializeLabels(labels)) || 0;
  }

  getAll(): Array<{ labels: string; value: number }> {
    return Array.from(this.values.entries()).map(([labels, value]) => ({ labels, value }));
  }

  reset(): void {
    this.values.clear();
  }
}

export interface HistogramStats {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export class Histogram {
  public readonly name: string;
  public readonly help: string;
  public readonly defaultBuckets: number[];
  private observations: Map<string, number[]> = new Map();

  constructor(name: string, help: string, buckets = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]) {
    this.name = name;
    this.help = help;
    this.defaultBuckets = [...buckets].sort((a, b) => a - b);
  }

  observe(value: number, labels?: MetricLabels): void {
    const key = serializeLabels(labels);
    let series = this.observations.get(key);
    if (!series) {
      series = [];
      this.observations.set(key, series);
    }
    series.push(value);
  }

  getStats(labels?: MetricLabels): HistogramStats {
    const series = this.observations.get(serializeLabels(labels)) || [];
    if (series.length === 0) {
      return { count: 0, sum: 0, avg: 0, min: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
    }
    const sorted = [...series].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const count = sorted.length;

    const percentile = (p: number) => {
      const idx = Math.min(Math.floor((p / 100) * count), count - 1);
      return sorted[idx];
    };

    return {
      count,
      sum,
      avg: Math.round((sum / count) * 100) / 100,
      min: sorted[0],
      max: sorted[count - 1],
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
    };
  }

  getBucketCounts(labels?: MetricLabels): Array<{ le: number; count: number }> {
    const series = this.observations.get(serializeLabels(labels)) || [];
    return this.defaultBuckets.map((le) => ({
      le,
      count: series.filter((v) => v <= le).length,
    }));
  }

  getAllSeries(): Array<{ labels: string; stats: HistogramStats }> {
    return Array.from(this.observations.keys()).map((labels) => {
      const parsedLabels: MetricLabels = {};
      return {
        labels,
        stats: this.getStats(parsedLabels),
      };
    });
  }

  reset(): void {
    this.observations.clear();
  }
}

/**
 * ExportMetricsRegistry
 * Centralized registry holding standard export metrics.
 */
export class ExportMetricsRegistry {
  public readonly jobDurationMs: Histogram;
  public readonly storageDurationMs: Histogram;
  public readonly rowsExportedTotal: Counter;
  public readonly jobsTotal: Counter;
  public readonly errorsTotal: Counter;
  public readonly slowJobsTotal: Counter;
  public readonly storageOpsTotal: Counter;
  public readonly queueBacklog: Gauge;
  public readonly activeWorkers: Gauge;

  constructor() {
    this.jobDurationMs = new Histogram(
      'export_job_duration_ms',
      'Execution duration of export jobs in milliseconds',
      [50, 100, 250, 500, 1000, 2500, 5000, 10000]
    );

    this.storageDurationMs = new Histogram(
      'export_storage_duration_ms',
      'Duration of export storage operations in milliseconds',
      [10, 25, 50, 100, 250, 500, 1000, 2500]
    );

    this.rowsExportedTotal = new Counter(
      'export_rows_total',
      'Total number of rows exported across jobs'
    );

    this.jobsTotal = new Counter(
      'export_jobs_total',
      'Total number of export jobs processed by final status'
    );

    this.errorsTotal = new Counter(
      'export_errors_total',
      'Total count of errors encountered during export processing'
    );

    this.slowJobsTotal = new Counter(
      'export_slow_jobs_total',
      'Total count of export jobs that exceeded slow job SLA thresholds'
    );

    this.storageOpsTotal = new Counter(
      'export_storage_operations_total',
      'Total storage operations (write, encrypt, checksum, read)'
    );

    this.queueBacklog = new Gauge(
      'export_queue_backlog',
      'Current number of pending export jobs in queue'
    );

    this.activeWorkers = new Gauge(
      'export_active_workers',
      'Current number of active worker executions'
    );
  }

  /**
   * Generates Prometheus exposition format output.
   */
  toPrometheus(): string {
    const lines: string[] = [];

    const formatMetric = (name: string, help: string, type: 'counter' | 'gauge' | 'histogram', entries: Array<{ labels: string; value: number }>) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      if (entries.length === 0) {
        lines.push(`${name} 0`);
      } else {
        for (const e of entries) {
          lines.push(`${name}${e.labels} ${e.value}`);
        }
      }
    };

    formatMetric(this.jobsTotal.name, this.jobsTotal.help, 'counter', this.jobsTotal.getAll());
    formatMetric(this.rowsExportedTotal.name, this.rowsExportedTotal.help, 'counter', this.rowsExportedTotal.getAll());
    formatMetric(this.errorsTotal.name, this.errorsTotal.help, 'counter', this.errorsTotal.getAll());
    formatMetric(this.slowJobsTotal.name, this.slowJobsTotal.help, 'counter', this.slowJobsTotal.getAll());
    formatMetric(this.storageOpsTotal.name, this.storageOpsTotal.help, 'counter', this.storageOpsTotal.getAll());
    formatMetric(this.queueBacklog.name, this.queueBacklog.help, 'gauge', this.queueBacklog.getAll());
    formatMetric(this.activeWorkers.name, this.activeWorkers.help, 'gauge', this.activeWorkers.getAll());

    // Histograms
    lines.push(`# HELP ${this.jobDurationMs.name} ${this.jobDurationMs.help}`);
    lines.push(`# TYPE ${this.jobDurationMs.name} histogram`);
    const jobStats = this.jobDurationMs.getStats();
    for (const bucket of this.jobDurationMs.getBucketCounts()) {
      lines.push(`${this.jobDurationMs.name}_bucket{le="${bucket.le}"} ${bucket.count}`);
    }
    lines.push(`${this.jobDurationMs.name}_bucket{le="+Inf"} ${jobStats.count}`);
    lines.push(`${this.jobDurationMs.name}_sum ${jobStats.sum}`);
    lines.push(`${this.jobDurationMs.name}_count ${jobStats.count}`);

    return lines.join('\n') + '\n';
  }

  /**
   * Returns a snapshot object for dashboards and API consumers.
   */
  getSnapshot(): {
    jobs: { total: number; completed: number; failed: number; queued: number };
    rows: { total: number };
    errors: { total: number; byStage: Record<string, number> };
    slowJobs: { total: number };
    queue: { backlog: number; activeWorkers: number };
    latency: { job: HistogramStats; storage: HistogramStats };
  } {
    const errorEntries = this.errorsTotal.getAll();
    const byStage: Record<string, number> = {};
    for (const entry of errorEntries) {
      const match = entry.labels.match(/stage="([^"]+)"/);
      const stage = match ? match[1] : 'unknown';
      byStage[stage] = (byStage[stage] || 0) + entry.value;
    }

    return {
      jobs: {
        total: this.jobsTotal.getTotal(),
        completed: this.jobsTotal.get({ status: 'completed' }),
        failed: this.jobsTotal.get({ status: 'failed' }),
        queued: this.queueBacklog.get(),
      },
      rows: {
        total: this.rowsExportedTotal.getTotal(),
      },
      errors: {
        total: this.errorsTotal.getTotal(),
        byStage,
      },
      slowJobs: {
        total: this.slowJobsTotal.getTotal(),
      },
      queue: {
        backlog: this.queueBacklog.get(),
        activeWorkers: this.activeWorkers.get(),
      },
      latency: {
        job: this.jobDurationMs.getStats(),
        storage: this.storageDurationMs.getStats(),
      },
    };
  }

  reset(): void {
    this.jobDurationMs.reset();
    this.storageDurationMs.reset();
    this.rowsExportedTotal.reset();
    this.jobsTotal.reset();
    this.errorsTotal.reset();
    this.slowJobsTotal.reset();
    this.storageOpsTotal.reset();
    this.queueBacklog.reset();
    this.activeWorkers.reset();
  }
}

// Global singleton instance for easy import
export const defaultMetrics = new ExportMetricsRegistry();
