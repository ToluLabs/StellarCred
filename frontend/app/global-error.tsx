"use client";

import { useEffect } from "react";
import Link from "next/link";
import { IconAlertTriangle, IconRefresh, IconArrowLeft } from "@tabler/icons-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const digest = error.digest ? ` [digest: ${error.digest}]` : "";
    if (process.env.NODE_ENV === "production") {
      console.error("Fatal render error", digest);
    } else {
      console.error("Fatal render error:", error);
    }
  }, [error]);

  return (
    <html lang="en" data-theme="dark">
      <body style={{ margin: 0, backgroundColor: "#05050a", color: "#eeeef5" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            textAlign: "center",
            padding: "3rem 1.5rem",
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: "rgba(240,96,77,0.1)",
              border: "1px solid rgba(240,96,77,0.25)",
              display: "grid",
              placeItems: "center",
              marginBottom: "1.5rem",
            }}
          >
            <IconAlertTriangle size={28} color="#f0604d" stroke={1.5} />
          </div>

          <h1 style={{ fontSize: "2rem", margin: "0 0 0.5rem" }}>Critical error</h1>

          <p
            style={{
              fontSize: "0.9375rem",
              maxWidth: 400,
              lineHeight: 1.7,
              marginBottom: "2rem",
              color: "#888899",
            }}
          >
            The application encountered a fatal error. Please try reloading.
          </p>

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
            <button
              onClick={reset}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.45rem",
                padding: "0.55rem 1.1rem",
                borderRadius: "10px",
                border: "none",
                background: "#3ecf8e",
                color: "#05050a",
                fontWeight: 600,
                fontSize: "0.85rem",
                cursor: "pointer",
                transition: "all 0.2s ease",
              }}
            >
              <IconRefresh size={15} />
              Try again
            </button>
            <Link
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.45rem",
                padding: "0.55rem 1.1rem",
                borderRadius: "10px",
                border: "1px solid rgba(255,255,255,0.13)",
                background: "transparent",
                color: "#eeeef5",
                fontWeight: 500,
                fontSize: "0.85rem",
                cursor: "pointer",
                textDecoration: "none",
                transition: "all 0.2s ease",
              }}
            >
              <IconArrowLeft size={15} />
              Home
            </Link>
          </div>
        </div>
      </body>
    </html>
  );
}
