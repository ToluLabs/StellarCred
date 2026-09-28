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

## Optional Error Reporting

Unexpected 500 errors can be forwarded to an external error sink (e.g., Sentry, webhook) for operational awareness without requiring user reports.

### Configuration

Set the `ERROR_REPORTING_WEBHOOK` environment variable to enable error reporting:

```bash
ERROR_REPORTING_WEBHOOK=https://your-error-sink.example.com/api/errors
```

**Default:** Off (no error reporting when unset)

### Error Report Payload

When enabled, 500 errors trigger a POST to the configured webhook with the following JSON payload:

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

### Timeout

Error reporting requests have a 5-second timeout to avoid hanging the API response. Failures are logged locally but do not affect the user response.

### Environment Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `ERROR_REPORTING_WEBHOOK` | No | (unset) | Webhook URL for 500 error reporting. Unset = disabled. |

Add to your environment configuration (e.g., `.env.local` or production secrets manager):

```bash
# Optional: Forward unexpected 500 errors to an error sink
ERROR_REPORTING_WEBHOOK=https://your-sentry-or-webhook.example.com/api/errors
```

---

## Implementation Details

- **Middleware**: `frontend/middleware.ts` - Logs all API requests and triggers error reporting
- **Error Reporting**: `frontend/lib/error-reporting.ts` - Handles webhook delivery
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
