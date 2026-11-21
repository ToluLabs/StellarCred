# StellarCred Observability & Error Monitoring Guide

This document describes how server-side exception monitoring, distributed request tracing, and Sentry integration are structured in StellarCred (#853).

---

## 1. Overview

StellarCred monitors server-side exceptions across API routes to accelerate production and staging debugging while preserving strict cryptographic and data privacy guarantees:

- **Exception Tracking**: Server-side runtime errors and unhandled exceptions are captured and forwarded to Sentry.
- **Contextual Metadata**: Every error event is automatically enriched with operational tags (`env`, `commit`, `service`, `requestId`, `path`, `method`).
- **Zero Sensitive Data Guarantee**: No credentials, private witness salts, private keys, authorization headers, or PII are ever sent to Sentry.

---

## 2. Configuration

Set the Sentry DSN in your deployment environment:

```env
# Sentry DSN for server-side error capturing
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0

# Optional runtime tags (auto-detected if unset)
NODE_ENV=production
APP_ENV=staging
GIT_COMMIT=b98d3f6
```

If `SENTRY_DSN` is omitted, the Sentry client runs in silent mock mode (ideal for local development and offline unit tests).

---

## 3. Architecture

### Server Error Boundary (`withSentryRouteHandler`)

API route handlers are wrapped with the Sentry error boundary helper:

```typescript
import { withApiErrorBoundary } from "@/app/api/_middleware";
import { NextRequest, NextResponse } from "next/server";

export const POST = withApiErrorBoundary(async (req: NextRequest) => {
  // Your API logic here...
  return NextResponse.json({ success: true });
});
```

When an unhandled exception occurs:
1. The error boundary intercepts the exception.
2. Extracts request correlation metadata (`x-request-id`, method, path).
3. Attaches operational tags:
   - `env`: `staging` | `production` | `development`
   - `commit`: Git SHA of deployed release
   - `service`: `stellarcred-api`
   - `requestId`: Request correlation ID
   - `path`: API route path
4. Forwards the event to Sentry with stack frames.
5. Returns a sanitized 500 JSON response:
   ```json
   {
     "error": "Internal Server Error",
     "requestId": "4c3b2a1f0e9d8c7b",
     "code": "INTERNAL_ERROR"
   }
   ```

---

## 4. Privacy & Payload Sanitization

StellarCred enforces privacy before any payload leaves the server:

1. **Request Body Dropping**: Inbound HTTP request bodies (which may contain secrets, private witness values, or signatures) are **never** attached to Sentry events.
2. **Header Allowlist**: Only non-sensitive headers (`accept`, `content-type`, `user-agent`, `x-request-id`, `host`) are forwarded. Authorization headers, cookies, and bearer tokens are dropped.
3. **Message Sanitization**: Exception messages are scanned and redacted:
   - Email patterns -> `[redacted-email]`
   - Dates of birth (`YYYY-MM-DD`) -> `[redacted-date]`
   - Numbers with 6+ digits (government IDs, account IDs) -> `[redacted-id]`

---

## 5. Triaging Sentry Events

### Accessing Issues in Sentry

1. Open the **Sentry Dashboard** -> Projects -> **stellarcred-api**.
2. Filter issues by tags:
   - By Environment: `env:staging` or `env:production`
   - By Release / Commit: `commit:<git-sha>` or `release:stellarcred-api@0.1.0`
   - By Request ID: `requestId:<id-from-user-report>`
   - By Endpoint: `path:/api/issue` or `path:/api/webhooks/issuance`

### Triage Workflow

1. **Verify Impact**: Look at the issue frequency and affected users (correlated by `requestId`).
2. **Trace Logs**: Copy the `requestId` tag from Sentry and grep application logs (`pino` structured output) to view the request lifecycle:
   ```bash
   grep "4c3b2a1f0e9d8c7b" app.log
   ```
3. **Inspect Stack Trace**: Review source file names and line numbers to locate the offending code.
4. **Resolve & Archive**: Once fixed in a PR, mark the issue resolved in the next release tag.
