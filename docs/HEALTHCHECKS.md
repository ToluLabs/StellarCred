# StellarCred Health Checks

This document defines the health, readiness and liveness endpoints that
StellarCred exposes, the exact response values each one returns, and how to
wire them into deployment checks, container orchestration and monitoring.

Service owners can use this document to answer three questions without reading
source code:

1. **Is the process alive?** — a liveness probe.
2. **Can it serve traffic right now?** — a readiness probe.
3. **Which build is running?** — the version metadata in every response.

---

## 1. Endpoint overview

StellarCred runs two long-running services. Each exposes at least one health
endpoint, and every one of them returns a JSON document with a `status`, a
`service` name and version metadata.

| Service | Endpoint | Kind | Answers | Use for |
| :--- | :--- | :--- | :--- | :--- |
| Frontend (Next.js) | `GET /api/health` | Liveness | `200` always | Container/orchestrator liveness, "is the server up" checks. |
| Frontend (Next.js) | `GET /api/ready` | Readiness | `200` ready / `503` not ready | Traffic gating, deployment gates, `APIReadyFailing` alert. |
| Indexer (Express) | `GET /health` | Liveness + readiness | `200` serving / `503` database unreachable | Container health, indexer alerting, "is the data flowing" checks. |

The split matters:

- **Liveness** answers "is the process running?". It must not depend on any
  external system, because a failing external system should never cause the
  orchestrator to restart a perfectly healthy process.
- **Readiness** answers "can this process serve traffic right now?". It may
  depend on external systems, and it is what a load balancer should watch.

The frontend therefore has two endpoints and the indexer has one: the indexer's
`/health` performs a single cheap database read, so it doubles as a readiness
check without the risk of a liveness probe that restarts the worker whenever
the database hiccups.

All three endpoints are **public** — they never require an API key, a bearer
token or any credential. They expose operational metadata only, never user
data, keys or PII.

---

## 2. Common response fields

Every health response carries the same four identity fields, so a single probe
script can read all three endpoints:

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `status` | `"ok"` \| `"degraded"` \| `"error"` | Coarse health of the service. `"degraded"` is used by the indexer to mean "working, but a dependency is unhappy". |
| `service` | `string` | Stable service identifier: `stellarcred-frontend` or `stellarcred-indexer`. Never changes between releases. |
| `version` | `string` | The deployed version. Always a non-empty string; `"dev"` when the build did not stamp one. |
| `timestamp` | `number` | Unix time in **milliseconds** at which the response was produced. |

---

## 3. Frontend — `GET /api/health`

**Kind:** liveness. **Implementation:** `frontend/app/api/health/route.ts`.

This endpoint performs **no dependency I/O**. It does not call the RPC, the
database, Persona, Plaid or the indexer. It answers as long as the Next.js
server can serve a request, which makes it safe to poll at a high frequency
and safe to use as a container liveness probe.

```bash
curl -sS http://localhost:3000/api/health
```

```json
{
  "status": "ok",
  "ready": true,
  "service": "stellarcred-frontend",
  "version": "1.4.0",
  "app_version": "1.4.0",
  "timestamp": 1724000000000,
  "uptime_seconds": 3600,
  "outboundSink": {
    "queued": 0,
    "delivered": 128,
    "dropped": 0,
    "failed": 0
  }
}
```

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `status` | `"ok"` | Always `"ok"` — the server answered. |
| `ready` | `true` | Always `true` here. The authoritative readiness signal is `/api/ready`. |
| `service` | `string` | `stellarcred-frontend`. |
| `version` | `string` | The deployed version (see §6). |
| `app_version` | `string` | The same value as `version`. Kept for parity with `/api/capabilities` and the SDK, which expose `app_version`. |
| `timestamp` | `number` | Unix milliseconds. |
| `uptime_seconds` | `number` | Process uptime, rounded to whole seconds. |
| `outboundSink` | `object` | Counters for the asynchronous outbound sink: `queued`, `delivered`, `dropped`, `failed`. A rising `dropped` or `failed` count means issuances are being lost on their way out — see `docs/LOGGING.md`. |

### Status codes

| Code | When |
| :--- | :--- |
| `200` | Always, while the server can serve requests. |
| `5xx` | Only if the server itself is broken. Treat a non-`200` here as a restart signal. |

### Notes

- The response carries `Cache-Control: no-store`. Do not let a CDN or reverse
  proxy cache it — a cached `200` would keep a dead instance in the load
  balancer.
- The endpoint is **not** in the public CORS allowlist (only `/api/capabilities`
  is). Poll it from the server, the orchestrator or a monitoring agent, not from
  a browser on another origin.

---

## 4. Frontend — `GET /api/ready`

**Kind:** readiness. **Implementation:** `frontend/app/api/ready/route.ts`.

This endpoint answers whether the frontend can actually process traffic. It
checks the four dependencies a live issuance flow needs and reports each one
individually, so an operator can see **which** dependency is broken rather than
just that something is.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/ready
```

```json
{
  "ready": true,
  "signer": { "status": "ok", "issuer": "configured" },
  "contracts": { "status": "ok" },
  "contract_versions": {
    "issuerRegistry": { "address": "C...", "version": "1.0.0", "status": "ok" },
    "credentialVerifier": { "address": "C...", "version": "1.0.0", "status": "ok" },
    "proofRegistry": { "address": "C...", "version": "1.0.0", "status": "ok" },
    "gatedPool": { "address": "C...", "version": "1.0.0", "status": "ok" }
  },
  "rpc": { "status": "ok" },
  "persona": { "status": "ok" },
  "app_version": "1.4.0",
  "deployment_timestamp": 1724000000000
}
```

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `ready` | `boolean` | `true` only when **all four** checks below pass. |
| `signer` | `object` | `status` (`"ok"`/`"error"`), optional `message`, and `issuer`: `"configured"` when `ISSUER_PRIVATE_KEY` is set, `"demo"` when the app falls back to the public demo issuer key. A `"demo"` signer is `status: "error"` — it is not a production configuration. |
| `contracts` | `object` | `status` plus, on failure, a `message` naming the missing `NEXT_PUBLIC_*_ID` variables. |
| `contract_versions` | `object` | Present only when the contracts are configured. Maps contract name to `{ address, version, status }`. Absent when the deployment is missing contract IDs. |
| `rpc` | `object` | `status` of a `getNetwork` call against the Soroban RPC, with a 5-second timeout. |
| `persona` | `object` | `status: "ok"` with the message `not configured (demo mode)` when `PERSONA_API_KEY` is unset — that is a valid demo configuration, not a failure. |
| `app_version` | `string` | The deployed version. |
| `deployment_timestamp` | `number` | Unix milliseconds at which the response was produced. |

### Status codes

| Code | When |
| :--- | :--- |
| `200` | Every dependency check passed. |
| `503` | At least one check failed. The body names the failing dependency. |

### Notes

- The response carries `Cache-Control: no-store`. A cached readiness verdict is
  worse than no verdict: a stale `503` keeps traffic away from a recovered
  service, and a stale `200` pushes traffic at a broken one.
- The RPC check has a 5-second timeout, so the endpoint always answers within
  roughly that bound. Set the probe timeout above it (10 seconds is a good
  default) so a slow RPC is reported as a failed readiness check rather than a
  probe timeout.
- The contract check uses the same `missingContractEnvVars()` helper as the
  user-facing configuration banner, so the banner and the readiness verdict can
  never disagree about which variables are missing.

---

## 5. Indexer — `GET /health`

**Kind:** liveness and readiness. **Implementation:**
`services/indexer/src/health.ts` (payload) and `services/indexer/src/api.ts`
(route).

The indexer is the background worker that reads `ProofRegistry` events off the
chain and writes them into the claims store. Its health endpoint reports both
whether the process is alive and whether the data pipeline is actually working,
so an operator can tell a crashed worker from a stalled one.

```bash
curl -sS http://localhost:3001/health
```

```json
{
  "status": "ok",
  "ready": true,
  "service": "stellarcred-indexer",
  "version": "1.0.0",
  "timestamp": 1724000000000,
  "uptimeSeconds": 3600,
  "lastLedger": 1234567,
  "headLedger": 1234570,
  "lag": 3,
  "consecutiveErrors": 0,
  "lastError": null,
  "lastErrorTime": null,
  "lastSuccessLedger": 1234567,
  "fetchAttempts": 1204,
  "fetchFailures": 0
}
```

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `status` | `"ok"` \| `"degraded"` \| `"error"` | Coarse pipeline health, derived from `consecutiveErrors` (see the table below). |
| `ready` | `boolean` | `true` unless `status` is `"error"`. The traffic-routing signal. |
| `service` | `string` | `stellarcred-indexer`. |
| `version` | `string` | The deployed version (see §6). |
| `timestamp` | `number` | Unix milliseconds. |
| `uptimeSeconds` | `number` | Process uptime, rounded to whole seconds. |
| `lastLedger` | `number` | Ledger sequence of the most recently persisted event. `0` when nothing has been indexed yet. |
| `headLedger` | `number` | Current chain head as observed by the ingester. `0` when unknown. |
| `lag` | `number` | `headLedger - lastLedger`. `-1` when the head is unknown. Alert when this grows. |
| `consecutiveErrors` | `number` | Consecutive failed fetch ticks. `0` means healthy. |
| `lastError` | `string` \| `null` | Message from the most recent failed fetch. |
| `lastErrorTime` | `number` \| `null` | Unix milliseconds of the most recent failed fetch. |
| `lastSuccessLedger` | `number` | Ledger of the last successfully persisted event. |
| `fetchAttempts` | `number` | Total fetch attempts since start. |
| `fetchFailures` | `number` | Total failed fetches since start (all retries exhausted). |
| `error` | `string` | **Only** present when the check itself failed (see below). |

### Status semantics

| `status` | Condition | `ready` | What it means |
| :--- | :--- | :--- | :--- |
| `ok` | `consecutiveErrors == 0` | `true` | Data is flowing. |
| `degraded` | `1 <= consecutiveErrors < 3` | `true` | A fetch failed, but recent history is healthy. The indexer is retrying with backoff. |
| `error` | `consecutiveErrors >= 3` | `false` | The indexer is very likely stalled and its data may be stale. Route traffic away and investigate. |

The threshold (`DEGRADED_ERROR_THRESHOLD = 3`) is deliberately forgiving: a
single failed poll against a public RPC endpoint is normal and must not take
the worker out of rotation.

### Status codes

| Code | When | Body |
| :--- | :--- | :--- |
| `200` | The service answered and the database is reachable. `status` may still be `"degraded"` or `"error"` — the **body** carries that detail. | Full health document. |
| `503` | The database could not be read. The process is alive but cannot serve data. | The same health document with `status: "error"`, `ready: false` and an `error` message. |

A `503` body looks like this:

```json
{
  "status": "error",
  "ready": false,
  "service": "stellarcred-indexer",
  "version": "1.0.0",
  "timestamp": 1724000000000,
  "uptimeSeconds": 3600,
  "lastLedger": 0,
  "headLedger": 1234570,
  "lag": 0,
  "consecutiveErrors": 0,
  "lastError": null,
  "lastErrorTime": null,
  "error": "SQLITE_CANTOPEN: unable to open database file"
}
```

Every response — success or failure — is a complete health document, so a
probe has a single parsing path.

### Why the HTTP status does not mirror `status`

A `status` of `"error"` (three consecutive failed fetches) still answers
`200`. The worker is running and can serve the claims it already has; it is
the *pipeline* that is stalled, not the process. Restarting the container every
time a public RPC endpoint hiccups three times in a row would turn a transient
network problem into an outage and lose the in-memory cursor.

Use the `ready` field — not the HTTP status — to decide whether to route
traffic to the indexer.

### Notes

- The endpoint is public: it bypasses the API-key guard even when `API_KEY` is
  configured.
- It sits behind the per-IP rate limiter (default 120 requests per 60 seconds,
  `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS`). A scraper polling faster
  than that shares its budget with real API traffic. At the default 15-second
  Docker healthcheck interval a probe uses 4 requests per minute, which is
  well within the limit; raise `RATE_LIMIT_MAX` if you scrape more often.
- `GET /metrics` exposes the same counters in Prometheus format
  (`indexer_events_processed_total`, `indexer_fetch_errors_total`,
  `indexer_uptime_seconds`, `indexer_db_write_latency_seconds`,
  `indexer_ledgers_behind_head`). Prefer `/metrics` for continuous scraping and
  `/health` for probes.

---

## 6. Version metadata

The `version` field identifies the running build, so a probe response tells you
exactly which artifact answered.

| Service | Source of truth | Resolution order |
| :--- | :--- | :--- |
| Frontend | `NEXT_PUBLIC_APP_VERSION` | The environment variable, or `"dev"` when it is unset or blank. |
| Indexer | `INDEXER_VERSION` | `INDEXER_VERSION`, then `npm_package_version` (set by npm when the service is started through a package script), then `"dev"`. |

Both values are read at request time, so the version reported is the version of
the process that answered — not a value baked into a build artifact at compile
time.

Set them in a deployment:

```yaml
# docker-compose.yml
environment:
  NEXT_PUBLIC_APP_VERSION: ${NEXT_PUBLIC_APP_VERSION:-dev}   # frontend
  INDEXER_VERSION: ${INDEXER_VERSION:-dev}                   # indexer
```

```yaml
# Kubernetes
env:
  - name: INDEXER_VERSION
    valueFrom:
      configMapKeyRef: { name: stellarcred-release, key: version }
```

Use an immutable identifier — a release tag or the commit SHA — rather than a
mutable one. `1.4.0` and `b98d3f6` both work; `latest` does not, because it
cannot tell you which build a probe answered.

---

## 7. Integration

### 7.1 Docker and docker-compose

`services/indexer/Dockerfile` ships a `HEALTHCHECK` that polls the indexer's
own endpoint on the port the service actually listens on:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

`docker-compose.yml` adds a health check to both services, and the frontend
waits for the indexer to become healthy before it starts:

```yaml
healthcheck:
  test: ["CMD", "node", "-e",
    "require('http').get('http://localhost:3001/health',r=>{process.exit(r.statusCode===200?0:1)})"]
  interval: 15s
  timeout: 5s
  retries: 3
  start_period: 10s
```

`depends_on: condition: service_healthy` means the frontend never starts
against a database that the indexer cannot reach.

The frontend's compose health check uses `/api/health` (liveness) on purpose:
the container is alive if the server can serve requests. Traffic gating is the
load balancer's job, and it should use `/api/ready`.

### 7.2 Kubernetes

```yaml
spec:
  containers:
    - name: frontend
      livenessProbe:
        httpGet: { path: /api/health, port: 3000 }
        initialDelaySeconds: 20
        periodSeconds: 15
        timeoutSeconds: 5
        failureThreshold: 3
      readinessProbe:
        httpGet: { path: /api/ready, port: 3000 }
        initialDelaySeconds: 10
        periodSeconds: 10
        timeoutSeconds: 10
        failureThreshold: 3
    - name: indexer
      livenessProbe:
        httpGet: { path: /health, port: 3001 }
        initialDelaySeconds: 10
        periodSeconds: 15
        timeoutSeconds: 5
        failureThreshold: 3
      readinessProbe:
        httpGet: { path: /health, port: 3001 }
        initialDelaySeconds: 5
        periodSeconds: 10
        timeoutSeconds: 5
        failureThreshold: 3
```

Guidance:

- The **liveness** probe must be cheap and dependency-free. Point the
  frontend's liveness probe at `/api/health`, never at `/api/ready` — a probe
  that restarts the pod because the RPC is down converts a dependency outage
  into an application outage.
- The **readiness** probe decides whether the pod receives traffic. A failing
  readiness probe removes the pod from the Service without killing it.
- Set the readiness timeout above the RPC timeout in `/api/ready` (5 seconds),
  so a slow RPC is reported as "not ready" rather than as a probe error.
- For the indexer, both probes hit `/health`. A `503` there means the database
  is unreachable: the pod should leave the rotation, but it does not need to be
  restarted — the database is the thing that is broken.

### 7.3 Load balancers and platform health checks

Any platform that accepts a URL and a status code works:

| Platform | Setting | Value |
| :--- | :--- | :--- |
| AWS ALB target group | Health check path | `/api/ready` (frontend) |
| Google Cloud Run | Startup probe | `/api/health` |
| Vercel / Netlify | Deployment check | `GET /api/health` |
| Fly.io | `[[vm.http_service.checks]]` | `GET /health` on the indexer |

Use `/api/ready` when the platform can act on a non-2xx (stop routing traffic),
and `/api/health` when it can only distinguish "up" from "down".

### 7.4 CI and deployment gates

A deployment pipeline can use the same endpoints to decide whether a release
is healthy before traffic is shifted to it.

**Staging — gate the release on readiness:**

```bash
#!/usr/bin/env bash
set -euo pipefail

FRONTEND_URL="${FRONTEND_URL:-http://localhost:3000}"
INDEXER_URL="${INDEXER_URL:-http://localhost:3001}"

# The frontend must be alive…
code=$(curl -sS -o /dev/null -w '%{http_code}' "$FRONTEND_URL/api/health")
[ "$code" = "200" ] || { echo "frontend not alive (HTTP $code)"; exit 1; }

# …and ready to serve.
code=$(curl -sS -o /dev/null -w '%{http_code}' "$FRONTEND_URL/api/ready")
[ "$code" = "200" ] || { echo "frontend not ready (HTTP $code)"; exit 1; }

# The indexer must be able to reach its database.
code=$(curl -sS -o /dev/null -w '%{http_code}' "$INDEXER_URL/health")
[ "$code" = "200" ] || { echo "indexer not ready (HTTP $code)"; exit 1; }

echo "all health checks passed"
```

**Production — poll after the rollout, before the traffic shift.** Allow a
short warm-up window (the frontend needs a moment to boot and to warm its
proof caches) and then require the checks to stay green for several
consecutive polls, so a flapping deployment is not promoted:

```bash
for attempt in $(seq 1 10); do
  if curl -fsS "$FRONTEND_URL/api/ready" > /dev/null \
     && curl -fsS "$INDEXER_URL/health" > /dev/null; then
    echo "healthy after $attempt poll(s)"
    exit 0
  fi
  sleep 5
done
echo "health checks never passed"; exit 1
```

`curl -f` treats `503` as a failure, which is exactly the semantics a gate
wants.

---

## 8. Staging checklist

Before promoting a build to production, confirm in staging:

- [ ] `GET /api/health` returns `200` and `service` is `stellarcred-frontend`.
- [ ] `GET /api/health` reports the version you just built (not `dev`).
- [ ] `GET /api/ready` returns `200`, and `signer.issuer` is `configured` — not
      `demo`.
- [ ] `GET /api/ready` reports `contracts.status: "ok"` with no missing
      variables in `contracts.message`.
- [ ] `GET /api/ready` reports `rpc.status: "ok"`.
- [ ] `GET /api/ready` reports `persona.status: "ok"`.
- [ ] `GET /health` on the indexer returns `200` with `status: "ok"`.
- [ ] The indexer's `lag` is small and not growing between polls.
- [ ] `NEXT_PUBLIC_APP_VERSION` and `INDEXER_VERSION` are set in the
      deployment, so responses identify the build.
- [ ] The Docker health checks report `healthy` for both containers, and the
      frontend starts only after the indexer is healthy.

## 9. Production checklist

- [ ] The liveness probe points at `/api/health` (frontend) and `/health`
      (indexer) — never at a dependency-checking endpoint.
- [ ] The readiness probe points at `/api/ready` (frontend).
- [ ] Probe timeouts are above the endpoint's own timeout (5 s for the RPC
      check inside `/api/ready`).
- [ ] `failureThreshold` is high enough that a single slow poll does not
      restart a pod (3 is a good default).
- [ ] The alerting rules in `docker/prometheus/alert.rules.yml` are loaded —
      `APIReadyFailing` fires on a non-`200` from `/api/ready`, and
      `IndexerLagHigh` fires when the indexer falls behind the chain head.
- [ ] `RATE_LIMIT_MAX` is high enough for the monitoring scraper's polling
      rate.
- [ ] The version reported by every endpoint matches the release you intended
      to ship.

---

## 10. Monitoring and alerting

| Signal | Source | What to alert on |
| :--- | :--- | :--- |
| `APIReadyFailing` | `stellarcred_api_ready_status` | The readiness probe returns non-`200` for more than a minute. `docs/ALERTING.md`. |
| `IndexerLagHigh` | `stellarcred_indexer_ledgers_behind` | The indexer falls more than 10 ledgers behind the chain head, for 5 minutes. |
| `DemoIssuerKeyActiveInProduction` | `stellarcred_demo_issuer_mode` | The demo issuer key is active in production — a security violation. |
| Indexer not ready | `GET /health` → `ready` | `ready: false` for more than a few minutes. |
| Outbound sink failures | `GET /api/health` → `outboundSink.failed` / `.dropped` | A rising count means issuances are being dropped on the way out. `docs/LOGGING.md`. |
| Fetch error rate | `GET /metrics` → `indexer_fetch_errors_total` | A sustained increase means the RPC or Horizon endpoint is unhappy. |
| Ledgers behind head | `GET /metrics` → `indexer_ledgers_behind_head` | The indexer's own Prometheus view of the same lag. |

The alert rules are defined in `docker/prometheus/alert.rules.yml` and
documented in `docs/ALERTING.md`. They watch the same readiness endpoint the
deployment gates use, so an alert and a pipeline gate never disagree about
what "healthy" means.

---

## 11. Troubleshooting

| Symptom | Likely cause | What to do |
| :--- | :--- | :--- |
| `/api/health` returns `200` but the app is failing for users | A dependency is broken, not the server. | Check `/api/ready` and read the failing dependency's `message`. |
| `/api/ready` returns `503` with `contracts.status: "error"` | A `NEXT_PUBLIC_*_ID` variable is missing from the deployment. | The `message` names the exact variables. Compare against `frontend/.env.example`. |
| `/api/ready` returns `503` with `signer.issuer: "demo"` | `ISSUER_PRIVATE_KEY` is not set. | Set the issuer key for that environment. The `DemoIssuerKeyActiveInProduction` alert fires for this in production. |
| `/api/ready` returns `503` with `rpc.status: "error"` | The Soroban RPC is unreachable or slow. | Check `NEXT_PUBLIC_RPC_URL` and the RPC provider's status. The service is fine; only the RPC is down. |
| Indexer `/health` returns `503` | The database is unreachable. | The `error` field carries the driver's message. Check `DATABASE_URL` / `SQLITE_PATH` and that the database is up. |
| Indexer `/health` returns `200` with `status: "degraded"` | One or two consecutive fetches failed. | Usually transient. Watch `consecutiveErrors`; it must not reach 3. |
| Indexer `/health` returns `200` with `status: "error"` | Three or more consecutive fetches failed — the worker is stalled. | Check `lastError` and `lastErrorTime`, then the Horizon/RPC endpoints. The data may be stale. |
| The version reads `dev` everywhere | The release did not stamp the version variable. | Set `NEXT_PUBLIC_APP_VERSION` (frontend) and `INDEXER_VERSION` (indexer). |
| The indexer health check returns `429` | The scraper exceeded the per-IP rate limit. | Slow the polling interval or raise `RATE_LIMIT_MAX`. |
| The frontend container restarts repeatedly | The liveness probe is pointed at a dependency-checking endpoint. | Point it at `/api/health` instead. |

---

## 12. Related documentation

- `docs/ALERTING.md` — Prometheus alert rules and Alertmanager wiring.
- `docs/OBSERVABILITY.md` — Sentry error monitoring and request tracing.
- `docs/LOGGING.md` — structured logging, including the outbound sink counters
  exposed by `/api/health`.
- `services/indexer/README.md` — the full indexer HTTP API.
- `DEPLOYMENTS.md` — the release process and the contract version record.
