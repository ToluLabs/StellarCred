# StellarCred API Logging

This document describes the structured logging implementation for API routes and the optional error reporting configuration.

---

## Structured Request Logging

Every API request (`/api/*`) produces one structured log line with the following fields:

| Field | Type | Description |
|---|---|---|
| `event` | string | Always `"api_request"` |
| `method` | string | HTTP method (GET, POST, etc.) |
| `path` | string | API route path (e.g., `/api/issue`) |
| `status` | number | HTTP status code |
| `durationMs` | number | Request duration in milliseconds |
| `requestId` | string | Correlation ID for tracing |
| `traceId` | string | OpenTelemetry trace id (W3C `traceparent`, 32 hex chars) |
| `spanId` | string | Span id for this hop (16 hex chars) |
| `traceFlags` | number | W3C trace flags (`1` = sampled) |
| `traceparent` | string | Full W3C header echoed on the response |
| `demoIssuer` | boolean? | Present when using demo issuer key (no ISSUER_PRIVATE_KEY set) |
| `plaidMock` | boolean? | Present when Plaid is in mock mode (no PLAID_ACCESS_TOKEN set) |
| `personaDemo` | boolean? | Present when Persona is in demo mode (no PERSONA_API_KEY set) |

### Example Log Entry

```json
{
  "event": "api_request",
  "method": "POST",
  "path": "/api/issue",
  "status": 200,
  "durationMs": 1234,
  "requestId": "abc123def456",
  "demoIssuer": true,
  "plaidMock": true,
  "personaDemo": false
}
```

### PII Safety

All log fields are filtered through `stripSensitiveFields()` in `lib/logger.ts`, which only allows explicitly whitelisted fields. No user data, wallet addresses, or credential values are logged.

### Demo/Mock Mode Signals

The logging middleware detects and logs when the app is running in demo or mock modes:

- **demoIssuer**: `true` when `ISSUER_PRIVATE_KEY` is not set (using public demo key)
- **plaidMock**: `true` when `PLAID_ACCESS_TOKEN` is not set (returning mock balance)
- **personaDemo**: `true` when `PERSONA_API_KEY` is not set (skipping identity verification)

These signals help operators distinguish between production and demo deployments in logs.

### Plaid Multi-Item Aggregation

When proof-of-funds aggregates balances across several linked Plaid items, the
balance flow logs only counts and ordinals — never account names, balances, or
access tokens:

- **itemIndex**: which configured item (ordinal in the token list) a Plaid
  call relates to
- **itemCount** / **accountCount**: how many items were aggregated / how many
  depository accounts they contain
- **plaidMock**: now `true` when *neither* `PLAID_ACCESS_TOKEN` nor
  `PLAID_ACCESS_TOKENS` is set (returning mock balance)

---

## CSP Violation Reports

The Content Security Policy endpoint (`POST /api/csp-report`) parses and logs violation telemetry emitted by browsers.

### Events

- **`csp_violation`**: Logged at `warn` level for each normalized violation report received. Includes `requestId` and a sanitized `cspViolation` object:
  - `documentUri`: Origin and pathname of the document where the violation occurred (truncated to 200 chars).
  - `blockedUri`: Origin and pathname of the blocked resource, bare token (`data`, `blob`, etc.), or keyword (`inline`, `eval`).
  - `sourceFile`: Sanitized URL of the script or asset that caused the violation.
  - `effectiveDirective`: Directive that was violated (e.g., `script-src`, `connect-src`) (unknown if unrecognized).
  - `disposition`: Either `"report"` (for Report-Only headers) or `"enforce"` (or unknown if the browser sends something else).
  - `lineNumber` / `columnNumber` / `statusCode`: Optional finite integers if reported by the browser.
- **`csp_report_rate_limited`**: Logged at `warn` level when an IP exceeds the rate limit window on `/api/csp-report`. Includes requestId only. The client IP is not logged.

### PII Safety

CSP reports are strictly sanitized through `lib/csp-report.ts` and only the allowlisted cspViolation key reaches the log through stripSensitiveFields() in lib/logger.ts:
- Query strings, URL fragments, and credentials are removed from all URLs.
- Sensitive reporting fields (`script-sample`, `sample`, `original-policy`, `originalPolicy`, `referrer`) are stripped entirely and never logged.
- Inline script or data payloads (`data:`, `blob:`, `filesystem:`, etc.) are reduced to scheme names only.

### Rate Limiting

The reporting endpoint is protected by an in-memory rate limiter configured via `RATE_LIMIT_CSP_REPORT_IP`:

| Variable | Required | Default | Description |
|---|---|---|---|
| `RATE_LIMIT_CSP_REPORT_IP` | No | `30` | Maximum CSP report requests permitted per IP per window (default window: 60 seconds, set by RATE_LIMIT_WINDOW_SECONDS). |

---

## Shared outbound sink

Telemetry, audit notifications, and unexpected 500 errors use one bounded,
best-effort outbound sink. It applies one redaction boundary to all three
event types, never waits on a remote destination from the request path, and
tracks queued, delivered, failed, and dropped events. The audit file remains
hash-chained and is persisted locally before issuance returns.

The current counters are exposed by `GET /api/health` under `outboundSink`.

### Configuration

Set the shared destination with:

```bash
OUTBOUND_SINK_URL=https://your-error-sink.example.com/api/events
OUTBOUND_SINK_QUEUE_SIZE=256
```

**Default:** Network delivery is off when `OUTBOUND_SINK_URL` is unset. Local
audit persistence and in-process telemetry continue to work. The old
`ERROR_REPORTING_WEBHOOK` setting remains a deprecated compatibility alias.

### Error Report Payload

When enabled, outbound events trigger a POST to the configured sink. Error
events retain this redacted payload shape:

```json
{
  "timestamp": "2026-08-26T18:00:00.000Z",
  "method": "POST",
  "path": "/api/issue",
  "requestId": "abc123def456",
  "status": 500,
  "environment": "production"
}
```

### PII Safety

The error report contains no PII:
- No request bodies or headers
- No user data or wallet addresses
- No credential values
- Only operational metadata (method, path, requestId, status, environment)

### Timeout and drops

Outbound requests have a 5-second timeout. Failures and bounded-queue drops
are logged locally but do not affect the user response.

### Environment Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `OUTBOUND_SINK_URL` | No | (unset) | Shared destination for telemetry, audit, and error events. |
| `OUTBOUND_SINK_QUEUE_SIZE` | No | `256` | Maximum in-memory outbound queue depth. |
| `ERROR_REPORTING_WEBHOOK` | No | (unset) | Deprecated alias for the shared destination. |

Add to your environment configuration (e.g., `.env.local` or production secrets manager):

```bash
# Optional: Forward telemetry, audit, and error events to one sink
OUTBOUND_SINK_URL=https://your-sentry-or-webhook.example.com/api/events

# Deprecated compatibility alias
ERROR_REPORTING_WEBHOOK=https://your-sentry-or-webhook.example.com/api/errors
```

---

## Distributed tracing

The API middleware continues an inbound W3C `traceparent` (or starts a new
trace), logs its `traceId` / `spanId` on the `api_request` line, and returns
the context on the response's `traceparent` header. An OpenTelemetry-instrumented
caller therefore sees the same `trace_id` in both services, and Jaeger/Datadog
can join API logs to the caller's spans.

```bash
curl -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -D - https://api.example.com/api/health
# traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-<new-span-id>-01
```

Invalid headers are ignored (never trusted as correlation ids), and the
request id is still generated/echoed as before. The trace helpers live in
`frontend/lib/trace-context.ts`; `traceId`, `spanId`, `traceFlags` and
`traceparent` are on the logger's safe-field allowlist.

---

## Indexer JSON logs and trace context

`services/indexer` writes one JSON object per line to stdout. Every line has
`timestamp`, `level`, `message`, `service`, and - when written inside a request
or a span - `trace_id`, `span_id`, `trace_flags`, `parent_span_id` and
`request_id`. This is the format an observability platform indexes directly;
no plain-text `console.log` remains in the service.

```json
{"timestamp":"2026-01-01T00:00:00.000Z","level":"info","message":"http_request","service":"stellarcred-indexer","event":"http_request","method":"GET","path":"/health","status":200,"duration_ms":1.2,"trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","trace_flags":1,"request_id":"abc123"}
```

### Trace propagation

- **HTTP API**: `trace-middleware.ts` continues an inbound `traceparent`, emits
  one `http_request` line per call, and returns `traceparent` plus
  `x-request-id` on the response.
- **Ingestion and integrity**: each tick runs inside an `indexer.tick` span and
  each verification pass inside an `indexer.integrity_check` span, so the
  request id and trace id on their log lines identify the same unit of work.
- **Outbound calls**: Horizon and other HTTP requests get the active
  `traceparent` header (`injectTraceHeaders`), so a call can be followed from
  the indexer into the provider's logs.
- **Spans**: `withSpan()` records `span_name`, `duration_ms`, `status` and
  attributes in a `span.end` line at debug level; set `LOG_LEVEL=debug` to emit
  them.

### Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn` or `error`. |
| `OTEL_SERVICE_NAME` | No | `stellarcred-indexer` | `service` field on every indexer line. |

### Redaction

Values are redacted at the logging boundary. Keys containing `password`,
`passphrase`, `secret`, `private_key`, `api_key`, `authorization`, `cookie`,
`token`, `salt`, `witness`, `mnemonic` or `seed` become `[REDACTED]` at any
depth, exceptions are reduced to `{ name, message, stack }`, and long strings
are truncated. Request bodies and headers are never logged.

---

## Implementation Details

- **Indexer logger/spans**: `services/indexer/src/logging.ts`
- **Indexer request tracing**: `services/indexer/src/trace-middleware.ts`
- **API trace context**: `frontend/lib/trace-context.ts`
- **Middleware**: `frontend/middleware.ts` - Logs all API requests and triggers error reporting
- **Outbound Sink**: `frontend/lib/outbound-sink.ts` - Redaction, queueing, delivery, and drop metrics
- **Logger**: `frontend/lib/logger.ts` - Structured logging with sensitive field filtering
- **Safe Fields**: Updated `SAFE_FIELDS` array includes new logging fields

---

## Log Level Control

Control log verbosity via `LOG_LEVEL` environment variable:

```bash
LOG_LEVEL=info  # Default: info, warn, error
LOG_LEVEL=debug # Include debug-level logs
LOG_LEVEL=trace # Maximum verbosity
```

Valid values: `fatal`, `error`, `warn`, `info`, `debug`, `trace`
