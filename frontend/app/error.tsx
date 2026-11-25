"use client";

import { useEffect } from "react";
import Link from "next/link";
import { IconAlertTriangle, IconArrowLeft, IconRefresh } from "@tabler/icons-react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const digest = error.digest ? ` [digest: ${error.digest}]` : "";
    if (process.env.NODE_ENV === "production") {
      console.error("Unhandled render error", digest);
    } else {
      console.error("Unhandled render error:", error);
    }
  }, [error]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        textAlign: "center",
        padding: "3rem 1.5rem",
      }}
      className="reveal"
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "rgba(240,96,77,0.1)",
          border: "1px solid rgba(240,96,77,0.25)",
          display: "grid",
          placeItems: "center",
          marginBottom: "1.5rem",
        }}
      >
        <IconAlertTriangle size={24} color="var(--danger)" stroke={1.5} />
      </div>

      <h1 style={{ fontSize: "1.75rem", margin: "0 0 0.5rem" }}>Something went wrong</h1>

      <p
        className="muted"
        style={{ fontSize: "0.9375rem", maxWidth: 400, lineHeight: 1.7, marginBottom: "2rem" }}
      >
        An unexpected error occurred. You can try again or head back to the home page.
      </p>

      <div className="row" style={{ gap: "0.75rem" }}>
        <button className="btn btn-primary" onClick={reset}>
          <IconRefresh size={15} />
          Try again
        </button>
        <Link href="/" className="btn btn-secondary">
          <IconArrowLeft size={15} />
          Home
        </Link>
      </div>
    </div>
  );
}
