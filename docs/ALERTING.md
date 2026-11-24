# Observability & Prometheus Alerting Guide

This document details the alerting rules for key failure conditions in StellarCred, how to customize thresholds, and how to wire alert notifications to external channels via Prometheus Alertmanager.

---

## Key Paging Conditions & Alert Rules

Prometheus rule definitions are located in `docker/prometheus/alert.rules.yml`.

| Alert Name | Metric / PromQL Expression | Default Threshold | Severity | Description |
| :--- | :--- | :--- | :--- | :--- |
| **IndexerLagHigh** | `stellarcred_indexer_ledgers_behind > 10` | > 10 ledgers | `critical` | Indexer falls behind blockchain head. |
| **HighIssuanceFailureRate** | `(sum(rate(stellarcred_issuance_failures_total[5m])) / sum(rate(stellarcred_issuance_attempts_total[5m]))) > 0.05` | > 5% over 5m | `critical` | Issuance failures spike due to key misconfiguration or third-party outages. |
| **APIReadyFailing** | `stellarcred_api_ready_status == 0` | Failing > 1m | `critical` | `/api/ready` health probe returns non-200. |
| **DemoIssuerKeyActiveInProduction** | `stellarcred_demo_issuer_mode{env="production"} == 1` | Immediate (0m) | `critical` | Hardcoded demo issuer key detected in production. |

---

## Configurable Thresholds

Thresholds can be customized based on environment needs:

1. **Prometheus Rule Adjustments**: Update values directly in `docker/prometheus/alert.rules.yml`.
2. **Environment Overrides**: If using envsubst or Helm charts, parameterize thresholds using environment variables:
   - `INDEXER_LAG_THRESHOLD_LEDGERS` (default: `10`)
   - `ISSUANCE_FAILURE_RATE_THRESHOLD` (default: `0.05`)

---

## Wiring Notifications via Alertmanager

To deliver alerts to notification channels (Slack, Discord, PagerDuty, Webhooks), route Prometheus alerts to an **Alertmanager** instance.

### Example `alertmanager.yml` Configuration

```yaml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'slack-notifications'

receivers:
  - name: 'slack-notifications'
    slack_configs:
      - api_url: '[https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK](https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK)'
        channel: '#stellarcred-alerts'
        send_resolved: true
        title: '[{{ .Status | toUpper }}] {{ .CommonAnnotations.summary }}'
        text: '{{ .CommonAnnotations.description }}'

