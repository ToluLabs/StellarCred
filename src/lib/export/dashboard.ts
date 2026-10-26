/**
 * Export Observability - Dashboards & Health Telemetry
 *
 * Provides real-time dashboard data aggregations, system health status,
 * and a standalone HTML dashboard interface for export jobs.
 */

import { ExportMetricsRegistry, defaultMetrics } from './metrics';
import { ExportTracer, defaultTracer, TraceRecord } from './tracer';
import { AlertManager, ActiveAlert } from './alerts';
import { ExportJobQueue } from './worker';

export type SystemHealthStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';

export interface DashboardData {
  status: SystemHealthStatus;
  timestamp: string;
  summary: {
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    successRate: number;
    queueBacklog: number;
    activeWorkers: number;
    totalRowsExported: number;
    slowJobsCount: number;
    errorCount: number;
  };
  latency: {
    jobP50Ms: number;
    jobP95Ms: number;
    jobAvgMs: number;
    storageP95Ms: number;
  };
  errorsByStage: Record<string, number>;
  activeAlerts: ActiveAlert[];
  recentTraces: Array<{
    traceId: string;
    rootSpanName: string;
    status: string;
    durationMs: number;
    spanCount: number;
    startTime: string;
  }>;
}

export class ExportDashboardService {
  private metrics: ExportMetricsRegistry;
  private tracer: ExportTracer;
  private alertManager: AlertManager;
  private queue?: ExportJobQueue;

  constructor(
    metrics: ExportMetricsRegistry = defaultMetrics,
    tracer: ExportTracer = defaultTracer,
    alertManager: AlertManager = new AlertManager(metrics),
    queue?: ExportJobQueue
  ) {
    this.metrics = metrics;
    this.tracer = tracer;
    this.alertManager = alertManager;
    this.queue = queue;
  }

  getDashboardData(): DashboardData {
    // Run evaluation of alerts first to get latest state
    this.alertManager.evaluate();
    const activeAlerts = this.alertManager.getActiveAlerts();

    // Determine system status
    let status: SystemHealthStatus = 'HEALTHY';
    if (activeAlerts.some((a) => a.severity === 'critical')) {
      status = 'CRITICAL';
    } else if (activeAlerts.some((a) => a.severity === 'warning')) {
      status = 'DEGRADED';
    }

    const snapshot = this.metrics.getSnapshot();
    const completed = snapshot.jobs.completed;
    const failed = snapshot.jobs.failed;
    const totalFinished = completed + failed;
    const successRate = totalFinished > 0 ? Math.round((completed / totalFinished) * 1000) / 10 : 100;

    const recentTraces = this.tracer.getRecentTraces(10).map((t: TraceRecord) => ({
      traceId: t.traceId,
      rootSpanName: t.rootSpanName,
      status: t.status,
      durationMs: t.durationMs || 0,
      spanCount: t.spans.length,
      startTime: new Date(t.startTime).toISOString(),
    }));

    return {
      status,
      timestamp: new Date().toISOString(),
      summary: {
        totalJobs: snapshot.jobs.total,
        completedJobs: completed,
        failedJobs: failed,
        successRate,
        queueBacklog: this.queue ? this.queue.length : snapshot.queue.backlog,
        activeWorkers: snapshot.queue.activeWorkers,
        totalRowsExported: snapshot.rows.total,
        slowJobsCount: snapshot.slowJobs.total,
        errorCount: snapshot.errors.total,
      },
      latency: {
        jobP50Ms: snapshot.latency.job.p50,
        jobP95Ms: snapshot.latency.job.p95,
        jobAvgMs: snapshot.latency.job.avg,
        storageP95Ms: snapshot.latency.storage.p95,
      },
      errorsByStage: snapshot.errors.byStage,
      activeAlerts,
      recentTraces,
    };
  }

  renderDashboardHtml(): string {
    const data = this.getDashboardData();
    const statusColor = data.status === 'HEALTHY' ? '#10b981' : data.status === 'DEGRADED' ? '#f59e0b' : '#ef4444';

    const alertsHtml = data.activeAlerts.length === 0
      ? '<div class="alert-empty">✓ All systems operational — No active alerts</div>'
      : data.activeAlerts.map((alert) => `
        <div class="alert-item alert-${alert.severity}">
          <div class="alert-header">
            <span class="alert-badge">${alert.severity.toUpperCase()}</span>
            <strong>${alert.name}</strong>
          </div>
          <p class="alert-summary">${alert.summary}</p>
        </div>
      `).join('');

    const tracesHtml = data.recentTraces.length === 0
      ? '<tr><td colspan="5" class="empty-row">No export traces recorded yet</td></tr>'
      : data.recentTraces.map((t) => `
        <tr>
          <td><code>${t.traceId.slice(0, 12)}...</code></td>
          <td>${t.rootSpanName}</td>
          <td><span class="status-pill status-${t.status}">${t.status.toUpperCase()}</span></td>
          <td>${t.durationMs}ms</td>
          <td>${t.spanCount}</td>
        </tr>
      `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StellarCred - Export Observability Dashboard</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(22, 30, 49, 0.75);
      --border: rgba(255, 255, 255, 0.1);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 2rem; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
    .title-group h1 { font-size: 1.75rem; font-weight: 700; color: #fff; }
    .title-group p { color: var(--text-muted); font-size: 0.9rem; margin-top: 0.25rem; }
    .health-pill { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.5rem 1rem; border-radius: 9999px; font-weight: 600; font-size: 0.85rem; border: 1px solid var(--border); background: var(--card-bg); color: ${statusColor}; }
    .health-dot { width: 10px; height: 10px; border-radius: 50%; background: ${statusColor}; box-shadow: 0 0 10px ${statusColor}; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.25rem; margin-bottom: 2rem; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; backdrop-filter: blur(12px); }
    .card-title { color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
    .card-value { font-size: 1.85rem; font-weight: 700; color: #fff; }
    .card-subtext { color: var(--text-muted); font-size: 0.8rem; margin-top: 0.4rem; }
    .section-title { font-size: 1.2rem; font-weight: 600; margin-bottom: 1rem; color: #fff; }
    .alert-container { margin-bottom: 2rem; }
    .alert-empty { background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); color: var(--success); padding: 1rem; border-radius: 8px; font-size: 0.95rem; }
    .alert-item { padding: 1rem; border-radius: 8px; margin-bottom: 0.75rem; border-left: 4px solid; }
    .alert-critical { background: rgba(239, 68, 68, 0.15); border-left-color: var(--danger); }
    .alert-warning { background: rgba(245, 158, 11, 0.15); border-left-color: var(--warning); }
    .alert-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
    .alert-badge { font-size: 0.7rem; font-weight: 700; padding: 0.15rem 0.4rem; border-radius: 4px; background: rgba(255, 255, 255, 0.15); }
    .alert-summary { font-size: 0.9rem; color: #e5e7eb; }
    .table-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 2rem; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem; }
    th { background: rgba(0, 0, 0, 0.2); padding: 0.85rem 1.25rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
    td { padding: 0.85rem 1.25rem; border-top: 1px solid var(--border); }
    .status-pill { padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .status-ok { background: rgba(16, 185, 129, 0.2); color: var(--success); }
    .status-error { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    .status-unset { background: rgba(156, 163, 175, 0.2); color: var(--text-muted); }
    .empty-row { text-align: center; color: var(--text-muted); padding: 2rem; }
    code { font-family: monospace; background: rgba(255, 255, 255, 0.08); padding: 0.15rem 0.35rem; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="title-group">
        <h1>Export Jobs Observability</h1>
        <p>Real-time metrics, distributed traces, and automated alert monitoring</p>
      </div>
      <div class="health-pill">
        <span class="health-dot"></span>
        <span>${data.status}</span>
      </div>
    </header>

    <section class="alert-container">
      <h2 class="section-title">Active Alerts</h2>
      ${alertsHtml}
    </section>

    <section class="grid">
      <div class="card">
        <div class="card-title">Success Rate</div>
        <div class="card-value">${data.summary.successRate}%</div>
        <div class="card-subtext">${data.summary.completedJobs} succeeded / ${data.summary.failedJobs} failed</div>
      </div>
      <div class="card">
        <div class="card-title">Queue Backlog</div>
        <div class="card-value">${data.summary.queueBacklog}</div>
        <div class="card-subtext">${data.summary.activeWorkers} active worker(s)</div>
      </div>
      <div class="card">
        <div class="card-title">Rows Exported</div>
        <div class="card-value">${data.summary.totalRowsExported.toLocaleString()}</div>
        <div class="card-subtext">Across ${data.summary.totalJobs} total jobs</div>
      </div>
      <div class="card">
        <div class="card-title">Latency (P95)</div>
        <div class="card-value">${data.latency.jobP95Ms}ms</div>
        <div class="card-subtext">Avg: ${data.latency.jobAvgMs}ms | Storage P95: ${data.latency.storageP95Ms}ms</div>
      </div>
    </section>

    <section>
      <h2 class="section-title">Recent Job Traces</h2>
      <div class="table-card">
        <table>
          <thead>
            <tr>
              <th>Trace ID</th>
              <th>Root Operation</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Spans</th>
            </tr>
          </thead>
          <tbody>
            ${tracesHtml}
          </tbody>
        </table>
      </div>
    </section>
  </div>
</body>
</html>`;
  }
}
