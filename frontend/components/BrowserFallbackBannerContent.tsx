"use client";

/**
 * BrowserFallbackBannerContent — Safe fallback UI content for unsupported browser capabilities (Issue #939).
 *
 * Displays a friendly, accessible warning when required browser features (WebCrypto,
 * WebAssembly, local storage, secure context) are missing or restricted, providing
 * clear actionable next steps and alternative instructions (e.g. Preview Mode,
 * switching to HTTPS, or using a modern browser) without crashing or dead-ending.
 */

import { useState } from "react";
import Link from "next/link";
import {
  IconAlertTriangle,
  IconInfoCircle,
  IconChevronDown,
  IconChevronUp,
  IconRefresh,
  IconEye,
  IconX,
} from "@tabler/icons-react";
import { useBrowserCompatibility } from "@/lib/hooks/useBrowserCompatibility";

export function BrowserFallbackBannerContent() {
  const { activeIssues, dismissIssue, dismissAll, recheck } = useBrowserCompatibility();
  const [expanded, setExpanded] = useState(false);

  if (activeIssues.length === 0) return null;

  const hasBlocking = activeIssues.some((i) => i.severity === "error");
  const borderColor = hasBlocking ? "rgba(240, 96, 77, 0.35)" : "rgba(227, 179, 65, 0.35)";
  const bgColor = hasBlocking ? "rgba(240, 96, 77, 0.08)" : "rgba(227, 179, 65, 0.08)";
  const iconColor = hasBlocking ? "var(--danger)" : "var(--warn)";

  const title = hasBlocking
    ? "Unsupported Browser Capabilities Detected"
    : "Limited Browser Capability Warning";

  const previewActionAvailable = activeIssues.some((i) => i.fallbackAvailable);

  return (
    <div
      role="alert"
      aria-live="polite"
      className="browser-fallback-banner"
      style={{
        width: "100%",
        borderBottom: `1px solid ${borderColor}`,
        background: bgColor,
        fontSize: "0.8125rem",
        padding: "0.75rem 1.25rem",
        boxSizing: "border-box",
        zIndex: 50,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.75rem",
          maxWidth: "1200px",
          margin: "0 auto",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            flex: "1 1 300px",
          }}
        >
          {hasBlocking ? (
            <IconAlertTriangle
              size={18}
              style={{ color: iconColor, flexShrink: 0 }}
              aria-hidden="true"
            />
          ) : (
            <IconInfoCircle
              size={18}
              style={{ color: iconColor, flexShrink: 0 }}
              aria-hidden="true"
            />
          )}

          <div>
            <strong style={{ color: "var(--text)", display: "inline-block" }}>{title}</strong>
            <span
              style={{
                color: "var(--text-secondary, #a1a1aa)",
                marginLeft: "0.5rem",
              }}
            >
              {hasBlocking
                ? "Some features (like ZK proof generation) are disabled, but you can continue safely in Preview Mode."
                : "Certain capabilities are restricted. Safe fallback mode is active."}
            </span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          {previewActionAvailable && (
            <Link
              href="/holder"
              className="btn btn-primary btn-sm"
              style={{
                fontSize: "0.75rem",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.3rem",
                padding: "0.25rem 0.6rem",
                textDecoration: "none",
              }}
            >
              <IconEye size={13} aria-hidden="true" />
              Preview Mode
            </Link>
          )}

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            style={{
              fontSize: "0.75rem",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.3rem",
              padding: "0.25rem 0.6rem",
            }}
          >
            {expanded ? (
              <>
                <IconChevronUp size={13} aria-hidden="true" /> Hide details
              </>
            ) : (
              <>
                <IconChevronDown size={13} aria-hidden="true" /> View details ({activeIssues.length}
                )
              </>
            )}
          </button>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={recheck}
            title="Recheck browser compatibility"
            style={{
              fontSize: "0.75rem",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
              padding: "0.25rem 0.5rem",
            }}
          >
            <IconRefresh size={13} aria-hidden="true" />
            Retry
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={dismissAll}
            title="Dismiss warning"
            aria-label="Dismiss compatibility warning"
            style={{
              fontSize: "0.75rem",
              display: "inline-flex",
              alignItems: "center",
              padding: "0.25rem 0.4rem",
              color: "var(--muted)",
            }}
          >
            <IconX size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {expanded && (
        <div
          style={{
            maxWidth: "1200px",
            margin: "0.75rem auto 0.25rem auto",
            paddingTop: "0.75rem",
            borderTop: `1px solid ${borderColor}`,
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
          }}
        >
          {activeIssues.map((issue) => (
            <div
              key={issue.id}
              style={{
                background: "rgba(0, 0, 0, 0.15)",
                borderRadius: "6px",
                padding: "0.6rem 0.85rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.35rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      padding: "0.1rem 0.35rem",
                      borderRadius: "3px",
                      background:
                        issue.severity === "error"
                          ? "rgba(240, 96, 77, 0.2)"
                          : "rgba(227, 179, 65, 0.2)",
                      color: issue.severity === "error" ? "var(--danger)" : "var(--warn)",
                    }}
                  >
                    {issue.severity}
                  </span>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>{issue.title}</span>
                </div>
                <button
                  type="button"
                  onClick={() => dismissIssue(issue.id)}
                  className="btn btn-ghost btn-sm"
                  style={{
                    fontSize: "0.7rem",
                    padding: "0.1rem 0.3rem",
                    color: "var(--muted)",
                  }}
                  title="Dismiss this item"
                  aria-label="Dismiss this item"
                >
                  Dismiss
                </button>
              </div>

              <div
                style={{
                  fontSize: "0.78rem",
                  color: "var(--text)",
                  lineHeight: 1.5,
                }}
              >
                {issue.description}
              </div>

              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-secondary, #a1a1aa)",
                }}
              >
                <strong>Impact:</strong> {issue.impact}
              </div>

              {issue.fallbackModeDescription && (
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--accent, #3ecf8e)",
                    background: "rgba(62, 207, 142, 0.08)",
                    padding: "0.25rem 0.5rem",
                    borderRadius: "4px",
                  }}
                >
                  {issue.fallbackModeDescription}
                </div>
              )}

              {issue.actionableSteps && issue.actionableSteps.length > 0 && (
                <div style={{ marginTop: "0.2rem" }}>
                  <div
                    style={{
                      fontSize: "0.72rem",
                      fontWeight: 600,
                      color: "var(--muted)",
                      marginBottom: "0.2rem",
                    }}
                  >
                    Actionable steps:
                  </div>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: "1.2rem",
                      fontSize: "0.75rem",
                      color: "var(--text)",
                      lineHeight: 1.45,
                    }}
                  >
                    {issue.actionableSteps.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
