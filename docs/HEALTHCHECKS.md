# Health checks

StellarCred exposes health endpoints for the frontend app and the indexer
worker so deployment and monitoring tooling can confirm each service is up and
responding before routing traffic or marking a rollout healthy.

| Service | Endpoint | Purpose |
| --- | --- | --- |
| Frontend (Next.js) | `GET /api/health` | Liveness: process is up and serving requests |
| Frontend (Next.js) | `GET /api/ready` | Readiness: signer, contracts, RPC and Persona config are usable |
| Indexer worker | `GET /health` | Liveness + ingestion health (ledger lag, fetch errors) |

All endpoints are unauthenticated, return JSON, and are safe to poll.

## Common fields

Both `/api/health` (frontend) and `/health` (indexer) return:

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `"ok" \| "degraded" \| "error"` | Coarse health state (frontend is always `"ok"` while it can respond) |
| `ready` | boolean | `true` when the service should receive traffic |
| `service` | string | `stellarcred-frontend` or `stellarcred-indexer` |
| `version` | string | Deployed version, `"dev"` when not set |
| `uptimeSeconds` | number | Seconds since the process started |
| `timestamp` | string | ISO-8601 time the response was generated |

### Version metadata

- Frontend: `NEXT_PUBLIC_APP_VERSION` (see `frontend/.env.example`).
- Indexer: `INDEXER_VERSION`, falling back to `npm_package_version` when started
  through `npm start`, then `"dev"`.

Set these in the deployment pipeline (e.g. to the release tag or commit SHA) so
the health response tells you exactly which build is running.

## Frontend `GET /api/health`

```json
{
  "status": "ok",
  "ready": true,
  "service": "stellarcred-frontend",
  "version": "1.0.0",
  "uptimeSeconds": 512,
  "timestamp": "2026-10-26T12:00:00.000Z",
  "outboundSink": { "...": "see docs/LOGGING.md" }
}
```

Always HTTP `200` while the process responds. Any non-200 or timeout means the
app is down. For dependency readiness use `GET /api/ready`, which returns `503`
with per-dependency details when it is not ready.

## Indexer `GET /health`

```json
{
  "status": "ok",
  "ready": true,
  "service": "stellarcred-indexer",
  "version": "1.0.0",
  "uptimeSeconds": 3600,
  "timestamp": "2026-10-26T12:00:00.000Z",
  "lastLedger": 123456,
  "headLedger": 123460,
  "lag": 4,
  "lastSuccessLedger": 123456,
  "lastError": null,
  "lastErrorTime": null,
  "consecutiveErrors": 0,
  "fetchAttempts": 1200,
  "fetchFailures": 0
}
```

| `status` | Condition | `ready` |
| --- | --- | --- |
| `ok` | `consecutiveErrors === 0` | `true` |
| `degraded` | 1–2 consecutive fetch failures | `true` |
| `error` | 3+ consecutive fetch failures (ingester likely stalled, data may be stale) | `false` |

`lag` is `headLedger - lastSuccessLedger`, or `-1` when the head ledger is not
yet known. The endpoint returns HTTP `200` whenever the process and database
respond (a database failure returns `500`); check the `ready` / `status` fields
to detect a stalled ingester.

## Deployment integration

### Staging

Gate each deploy on both services before promoting:

```sh
curl -fsS https://staging.example.com/api/health
curl -fsS https://staging.example.com/api/ready
curl -fsS http://indexer.staging.internal:3001/health | jq -e '.ready == true'
```

Also confirm the reported `version` matches the build you just deployed.

### Production

- **Liveness probes** (restart on failure): frontend `/api/health`, indexer
  `/health` (HTTP 200).
- **Readiness probes / load balancer** (stop routing on failure): frontend
  `/api/ready` (HTTP 200 vs 503).
- **Alerting**: alert when indexer `ready` is `false` or `status` is
  `degraded` for several minutes, or when `lag` exceeds your tolerance.

Kubernetes example:

```yaml
livenessProbe:
  httpGet: { path: /api/health, port: 3000 }
  periodSeconds: 15
readinessProbe:
  httpGet: { path: /api/ready, port: 3000 }
  periodSeconds: 15
```

Docker Compose already uses the indexer `/health` endpoint as a
`healthcheck` (see `docker-compose.yml`). To also fail the container when the
ingester is stalled, check the `ready` field:

```sh
node -e "fetch('http://localhost:3001/health').then(r=>r.json()).then(b=>process.exit(b.ready?0:1)).catch(()=>process.exit(1))"
```
