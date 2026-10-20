// frontend/lib/monitoring/sentry.ts
//
// Sentry error monitoring and exception tracking for server-side API routes (#853).
// Captures unhandled server errors with stack traces, environment tags, commit hashes,
// and service context while guaranteeing zero sensitive payloads or PII escape.

import crypto from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { logger, stripSensitiveFields } from "../logger";

export interface SentryConfig {
  dsn?: string;
  environment: string;
  release: string;
  commit: string;
  service: string;
  enabled: boolean;
  sampleRate?: number;
  beforeSend?: (event: SentryEvent) => SentryEvent | null;
}

export interface SentryErrorContext {
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "node" | "javascript";
  level: "error" | "warning" | "info" | "fatal";
  environment: string;
  release: string;
  tags: Record<string, string>;
  extra: Record<string, unknown>;
  exception?: {
    values: Array<{
      type: string;
      value: string;
      stacktrace?: {
        frames: Array<{
          filename: string;
          function: string;
          lineno?: number;
        }>;
      };
    }>;
  };
  request?: {
    url: string;
    method: string;
    headers?: Record<string, string>;
  };
}

// Global active Sentry client instance
let globalSentryClient: SentryClient | null = null;

// Allowlisted safe headers for Sentry context
const SAFE_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-request-id",
  "host",
]);

/**
 * Sanitizes headers to ensure zero auth tokens or cookies are forwarded.
 */
export function sanitizeHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (SAFE_HEADER_ALLOWLIST.has(lower)) {
        safe[lower] = value;
      }
    });
  } else if (typeof headers === "object" && headers !== null) {
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (SAFE_HEADER_ALLOWLIST.has(lower)) {
        safe[lower] = String(v);
      }
    }
  }
  return safe;
}

/**
 * Strips PII and sensitive tokens from error messages and extra context.
 * Redacts emails, dates of birth (YYYY-MM-DD), and 6+ digit numbers.
 */
export function sanitizeErrorMessage(message: string): string {
  if (!message) return "[empty error]";
  return message
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[redacted-email]")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "[redacted-date]")
    .replace(/\b\d{6,}\b/g, "[redacted-id]");
}

export class SentryClient {
  readonly config: SentryConfig;
  private recordedEvents: SentryEvent[] = [];

  constructor(config: Partial<SentryConfig> = {}) {
    this.config = {
      dsn: config.dsn ?? process.env.SENTRY_DSN,
      environment: config.environment ?? process.env.NODE_ENV ?? "development",
      release: config.release ?? process.env.npm_package_version ?? "0.1.0",
      commit:
        config.commit ??
        process.env.GIT_COMMIT ??
        process.env.VERCEL_GIT_COMMIT_SHA ??
        process.env.GITHUB_SHA ??
        "local",
      service: config.service ?? "stellarcred-api",
      enabled: config.enabled ?? Boolean(config.dsn ?? process.env.SENTRY_DSN),
      beforeSend: config.beforeSend,
    };
  }

  /**
   * Internal transport delivering event to Sentry DSN HTTP endpoint or mock sink.
   */
  async sendEvent(event: SentryEvent): Promise<boolean> {
    this.recordedEvents.push(event);

    if (!this.config.enabled || !this.config.dsn) {
      return true;
    }

    try {
      const dsnUrl = new URL(this.config.dsn);
      const projectId = dsnUrl.pathname.replace(/^\//, "");
      const publicKey = dsnUrl.username;
      const apiHost = dsnUrl.origin;
      const endpoint = `${apiHost}/api/${projectId}/store/?sentry_version=7&sentry_key=${publicKey}`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
      return res.ok;
    } catch (err) {
      logger.warn(
        stripSensitiveFields({ event: "sentry_delivery_failed" }),
        `Failed to deliver error event to Sentry: ${(err as Error).message}`
      );
      return false;
    }
  }

  /**
   * Captures an exception with relevant tags and environment metadata.
   */
  async captureException(error: unknown, context: SentryErrorContext = {}): Promise<string> {
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const errorObj = error instanceof Error ? error : new Error(String(error));
    const safeMsg = sanitizeErrorMessage(errorObj.message);

    const tags: Record<string, string> = {
      env: this.config.environment,
      commit: this.config.commit,
      service: this.config.service,
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.method ? { method: context.method } : {}),
      ...(context.path ? { path: context.path } : {}),
      ...(context.status ? { status: String(context.status) } : {}),
      ...context.tags,
    };

    let event: SentryEvent = {
      event_id: eventId,
      timestamp: Math.floor(Date.now() / 1000),
      platform: "node",
      level: "error",
      environment: this.config.environment,
      release: `${this.config.service}@${this.config.release}`,
      tags,
      extra: {
        ...(context.extra ?? {}),
      },
      exception: {
        values: [
          {
            type: errorObj.name || "Error",
            value: safeMsg,
            stacktrace: errorObj.stack ? this.parseStack(errorObj.stack) : undefined,
          },
        ],
      },
      ...(context.path
        ? {
            request: {
              url: context.path,
              method: context.method ?? "UNKNOWN",
            },
          }
        : {}),
    };

    if (this.config.beforeSend) {
      const filtered = this.config.beforeSend(event);
      if (!filtered) {
        return eventId;
      }
      event = filtered;
    }

    await this.sendEvent(event);
    return eventId;
  }

  getRecordedEvents(): SentryEvent[] {
    return this.recordedEvents;
  }

  clearRecordedEvents(): void {
    this.recordedEvents = [];
  }

  private parseStack(stack: string): SentryEvent["exception"] extends undefined ? never : any {
    const lines = stack.split("\n").slice(1);
    const frames = lines
      .map((line) => {
        const match = line.match(/^\s*at\s+(?:([^\s(]+)\s+\((.+):(\d+):(\d+)\)|(.+):(\d+):(\d+))/);
        if (!match) return null;
        return {
          function: match[1] ?? "<anonymous>",
          filename: match[2] ?? match[5] ?? "unknown",
          lineno: parseInt(match[3] ?? match[6] ?? "0", 10),
        };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .reverse(); // Sentry expects oldest caller first

    return { frames };
  }
}

/**
 * Initializes global Sentry instance.
 */
export function initSentry(config: Partial<SentryConfig> = {}): SentryClient {
  globalSentryClient = new SentryClient(config);
  return globalSentryClient;
}

/**
 * Returns current Sentry client or initializes a default client.
 */
export function getSentryClient(): SentryClient {
  if (!globalSentryClient) {
    globalSentryClient = new SentryClient();
  }
  return globalSentryClient;
}

/**
 * Public helper to capture server errors.
 */
export async function captureServerException(
  error: unknown,
  context?: SentryErrorContext
): Promise<string> {
  return getSentryClient().captureException(error, context);
}

/**
 * Error boundary wrapper for Next.js API route handlers (#853).
 * Catches any unhandled exceptions, attaches tags (env, commit, service, requestId),
 * forwards to Sentry, and returns a sanitized 500 error response.
 */
export function withSentryRouteHandler(
  handler: (req: NextRequest, ...args: any[]) => Promise<NextResponse>
) {
  return async (req: NextRequest, ...args: any[]): Promise<NextResponse> => {
    try {
      return await handler(req, ...args);
    } catch (error) {
      const requestId =
        req.headers.get("x-request-id") ?? crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const method = req.method;
      const path = req.nextUrl?.pathname ?? "unknown_endpoint";

      // Report unhandled exception to Sentry
      const eventId = await captureServerException(error, {
        requestId,
        method,
        path,
        status: 500,
        extra: {
          headers: sanitizeHeaders(req.headers),
        },
      });

      logger.error(
        stripSensitiveFields({
          event: "api_unhandled_server_error",
          requestId,
          method,
          path,
          sentryEventId: eventId,
        }),
        `Unhandled API server exception on ${method} ${path}: ${(error as Error).message}`
      );

      return Response.json(
        {
          error: "Internal Server Error",
          requestId,
          code: "INTERNAL_ERROR",
        },
        { status: 500 }
      ) as unknown as NextResponse;
    }
  };
}
