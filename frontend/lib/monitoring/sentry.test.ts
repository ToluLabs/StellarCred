// frontend/lib/monitoring/sentry.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  SentryClient,
  initSentry,
  getSentryClient,
  sanitizeErrorMessage,
  sanitizeHeaders,
  withSentryRouteHandler,
} from "./sentry";

describe("Sentry Error Monitoring (#853)", () => {
  let client: SentryClient;

  beforeEach(() => {
    client = initSentry({
      environment: "staging",
      commit: "commit_abc123",
      service: "stellarcred-api",
      enabled: true,
    });
    client.clearRecordedEvents();
  });

  it("attaches required tags (env, commit, service) to captured errors", async () => {
    const error = new Error("Database timeout on RPC call");
    const eventId = await client.captureException(error, {
      requestId: "req_xyz999",
      path: "/api/issue",
      method: "POST",
      status: 500,
    });

    expect(eventId).toBeTruthy();
    const events = client.getRecordedEvents();
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event.tags.env).toBe("staging");
    expect(event.tags.commit).toBe("commit_abc123");
    expect(event.tags.service).toBe("stellarcred-api");
    expect(event.tags.requestId).toBe("req_xyz999");
    expect(event.tags.path).toBe("/api/issue");
    expect(event.tags.method).toBe("POST");
    expect(event.tags.status).toBe("500");
  });

  it("sanitizes error messages containing emails, dates of birth, and IDs", () => {
    const raw =
      "Failed to process user@example.com born on 1990-05-15 with account 123456789";
    const sanitized = sanitizeErrorMessage(raw);

    expect(sanitized).not.toContain("user@example.com");
    expect(sanitized).not.toContain("1990-05-15");
    expect(sanitized).not.toContain("123456789");
    expect(sanitized).toContain("[redacted-email]");
    expect(sanitized).toContain("[redacted-date]");
    expect(sanitized).toContain("[redacted-id]");
  });

  it("drops sensitive authorization headers and cookies", () => {
    const headers = new Headers({
      authorization: "Bearer secret_jwt_token_12345",
      cookie: "session_id=abcdef",
      "x-api-key": "private_api_key",
      "user-agent": "Mozilla/5.0",
      "x-request-id": "req_123",
      "content-type": "application/json",
    });

    const safe = sanitizeHeaders(headers);
    expect(safe.authorization).toBeUndefined();
    expect(safe.cookie).toBeUndefined();
    expect(safe["x-api-key"]).toBeUndefined();
    expect(safe["user-agent"]).toBe("Mozilla/5.0");
    expect(safe["x-request-id"]).toBe("req_123");
    expect(safe["content-type"]).toBe("application/json");
  });

  it("error boundary withSentryRouteHandler catches unhandled errors and returns 500", async () => {
    const failingHandler = async () => {
      throw new Error("Unhandled failure in route handler");
    };

    const wrapped = withSentryRouteHandler(failingHandler);
    const req = new NextRequest("http://localhost:3000/api/failing-endpoint", {
      method: "POST",
      headers: { "x-request-id": "req_test_boundary_42" },
    });

    const res = await wrapped(req);
    expect(res.status).toBe(500);

    const data = await res.json();
    expect(data.error).toBe("Internal Server Error");
    expect(data.requestId).toBe("req_test_boundary_42");

    // Sentry should have received the event
    const events = client.getRecordedEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.tags.requestId).toBe("req_test_boundary_42");
    expect(lastEvent.tags.path).toBe("/api/failing-endpoint");
  });
});
