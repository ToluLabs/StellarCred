/**
 * Export Observability - Alert Rules & Alerting Engine
 *
 * Configures and evaluates alert rules for job failure spikes, queue backlog growth,
 * slow job SLA breaches, and storage operation failures.
 */

import { ExportMetricsRegistry, defaultMetrics } from './metrics';
import { ExportJobQueue } from './worker';

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'OK' | 'FIRING';

export interface AlertRule {
  id: string;
  name: string;
  severity: AlertSeverity;
  description: string;
  evaluate: (metrics: ExportMetricsRegistry, queue?: ExportJobQueue) => {
    isFiring: boolean;
    summary: string;
    details?: Record<string, any>;
  };
}

export interface ActiveAlert {
  id: string;
  name: string;
  severity: AlertSeverity;
  status: AlertStatus;
  summary: string;
  details: Record<string, any>;
  triggeredAt?: number;
  resolvedAt?: number;
}

export interface AlertNotification {
  alertId: string;
  name: string;
  severity: AlertSeverity;
  status: AlertStatus;
  summary: string;
  timestamp: number;
}

export interface AlertManagerConfig {
  failureRateThreshold?: number; // e.g. 0.15 (15%)
  backlogGrowthThreshold?: number; // e.g. 5 pending jobs
  slowJobThresholdMs?: number; // e.g. 1000ms
  minJobsForFailureRate?: number; // minimum jobs before rate triggers
}

export class AlertManager {
  private rules: Map<string, AlertRule> = new Map();
  private alertStates: Map<string, ActiveAlert> = new Map();
  private alertHistory: AlertNotification[] = [];
  private listeners: Array<(notification: AlertNotification) => void> = [];
  private metrics: ExportMetricsRegistry;
  private queue?: ExportJobQueue;

  constructor(
    metrics: ExportMetricsRegistry = defaultMetrics,
    queue?: ExportJobQueue,
    config: AlertManagerConfig = {}
  ) {
    this.metrics = metrics;
    this.queue = queue;

    const failureRateThreshold = config.failureRateThreshold ?? 0.15;
    const backlogThreshold = config.backlogGrowthThreshold ?? 5;
    const slowJobThreshold = config.slowJobThresholdMs ?? 1000;
    const minJobsForFailureRate = config.minJobsForFailureRate ?? 2;

    // Rule 1: Job Failure Spike
    this.registerRule({
      id: 'JOB_FAILURE_SPIKE',
      name: 'Job Failure Spike',
      severity: 'critical',
      description: 'Triggered when the export job failure rate or error count spikes beyond threshold',
      evaluate: (m) => {
        const completed = m.jobsTotal.get({ status: 'completed' });
        const failed = m.jobsTotal.get({ status: 'failed' });
        const total = completed + failed;

        if (total >= minJobsForFailureRate) {
          const failureRate = total > 0 ? failed / total : 0;
          if (failureRate >= failureRateThreshold) {
            return {
              isFiring: true,
              summary: `Export job failure rate at ${(failureRate * 100).toFixed(1)}% (${failed}/${total} jobs failed)`,
              details: { failed, completed, total, failureRate, threshold: failureRateThreshold },
            };
          }
        } else if (failed > 0 && completed === 0) {
          return {
            isFiring: true,
            summary: `Initial export jobs failing (${failed} failed with 0 successes)`,
            details: { failed, completed, total },
          };
        }

        return { isFiring: false, summary: 'Job failure rate is normal' };
      },
    });

    // Rule 2: Queue Backlog Growth
    this.registerRule({
      id: 'QUEUE_BACKLOG_GROWTH',
      name: 'Queue Backlog Growth',
      severity: 'warning',
      description: 'Triggered when the export queue backlog exceeds safe capacity',
      evaluate: (m, q) => {
        const backlog = q ? q.length : m.queueBacklog.get();
        if (backlog >= backlogThreshold) {
          return {
            isFiring: true,
            summary: `Export queue backlog is high: ${backlog} pending jobs (threshold: ${backlogThreshold})`,
            details: { backlog, threshold: backlogThreshold },
          };
        }
        return { isFiring: false, summary: 'Queue backlog is within normal limits' };
      },
    });

    // Rule 3: Slow Job SLA Breach
    this.registerRule({
      id: 'SLOW_JOB_SLA_BREACH',
      name: 'Slow Job SLA Breach',
      severity: 'warning',
      description: 'Triggered when export jobs breach duration SLA thresholds',
      evaluate: (m) => {
        const slowJobs = m.slowJobsTotal.getTotal();
        const latency = m.jobDurationMs.getStats();

        if (slowJobs > 0 || (latency.count > 0 && latency.p95 >= slowJobThreshold)) {
          return {
            isFiring: true,
            summary: `Detected ${slowJobs} slow export jobs (P95 latency: ${latency.p95}ms, threshold: ${slowJobThreshold}ms)`,
            details: { slowJobs, p95: latency.p95, p50: latency.p50, thresholdMs: slowJobThreshold },
          };
        }
        return { isFiring: false, summary: 'Job durations within SLA limits' };
      },
    });

    // Rule 4: Storage Operation Failure
    this.registerRule({
      id: 'STORAGE_FAILURE_RATE',
      name: 'Storage Operation Failure',
      severity: 'critical',
      description: 'Triggered when artifact persistence, encryption, or checksum operations fail',
      evaluate: (m) => {
        const storageErrors = m.errorsTotal.get({ stage: 'storage', code: 'WRITE_ERROR' }) +
          m.errorsTotal.get({ stage: 'storage', code: 'READ_ERROR' });
        const failedStorageOps = m.storageOpsTotal.get({ operation: 'write', status: 'failure' }) +
          m.storageOpsTotal.get({ operation: 'read', status: 'failure' });

        if (storageErrors > 0 || failedStorageOps > 0) {
          return {
            isFiring: true,
            summary: `Storage failure detected: ${storageErrors} errors across ${failedStorageOps} failed operations`,
            details: { storageErrors, failedStorageOps },
          };
        }
        return { isFiring: false, summary: 'Storage operations healthy' };
      },
    });
  }

  registerRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
    this.alertStates.set(rule.id, {
      id: rule.id,
      name: rule.name,
      severity: rule.severity,
      status: 'OK',
      summary: 'Initialized',
      details: {},
    });
  }

  addListener(listener: (notification: AlertNotification) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Evaluates all configured alert rules against current metrics.
   */
  evaluate(): ActiveAlert[] {
    const firing: ActiveAlert[] = [];
    const now = Date.now();

    for (const [id, rule] of this.rules.entries()) {
      const result = rule.evaluate(this.metrics, this.queue);
      const current = this.alertStates.get(id)!;

      if (result.isFiring) {
        if (current.status !== 'FIRING') {
          // Transition: OK -> FIRING
          current.status = 'FIRING';
          current.triggeredAt = now;
          current.resolvedAt = undefined;
          current.summary = result.summary;
          current.details = result.details || {};

          const notification: AlertNotification = {
            alertId: id,
            name: rule.name,
            severity: rule.severity,
            status: 'FIRING',
            summary: result.summary,
            timestamp: now,
          };
          this.alertHistory.push(notification);
          this.notify(notification);
        } else {
          // Update details while firing
          current.summary = result.summary;
          current.details = result.details || {};
        }
        firing.push({ ...current });
      } else {
        if (current.status === 'FIRING') {
          // Transition: FIRING -> OK (Resolved)
          current.status = 'OK';
          current.resolvedAt = now;
          current.summary = result.summary;

          const notification: AlertNotification = {
            alertId: id,
            name: rule.name,
            severity: rule.severity,
            status: 'OK',
            summary: `RESOLVED: ${rule.name} returned to normal`,
            timestamp: now,
          };
          this.alertHistory.push(notification);
          this.notify(notification);
        }
      }
    }

    return firing;
  }

  private notify(notification: AlertNotification): void {
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch {
        // Safe dispatch: errors in listeners shouldn't crash the manager
      }
    }
  }

  /**
   * Returns all currently firing alerts.
   */
  getActiveAlerts(): ActiveAlert[] {
    return Array.from(this.alertStates.values()).filter((a) => a.status === 'FIRING');
  }

  getAllAlerts(): ActiveAlert[] {
    return Array.from(this.alertStates.values());
  }

  getAlertHistory(): AlertNotification[] {
    return [...this.alertHistory];
  }

  reset(): void {
    this.alertHistory = [];
    for (const alert of this.alertStates.values()) {
      alert.status = 'OK';
      alert.triggeredAt = undefined;
      alert.resolvedAt = undefined;
    }
  }
}
