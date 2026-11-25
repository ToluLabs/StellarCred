import Link from "next/link";
import { IconRouteSquare, IconArrowLeft } from "@tabler/icons-react";

export default function NotFound() {
  return (
    <div
      className="reveal"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        textAlign: "center",
        padding: "3rem 1.5rem",
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "rgba(62,207,142,0.08)",
          border: "1px solid rgba(62,207,142,0.2)",
          display: "grid",
          placeItems: "center",
          marginBottom: "1.5rem",
        }}
      >
        <IconRouteSquare size={24} color="var(--accent)" stroke={1.5} />
      </div>

      <h1 style={{ fontSize: "3rem", margin: "0", letterSpacing: "-0.03em" }}>404</h1>
      <p
        className="muted"
        style={{ fontSize: "0.9375rem", maxWidth: 400, lineHeight: 1.7, margin: "0.5rem 0 2rem" }}
      >
        This page does not exist — or the proof was never generated here.
      </p>

      <Link href="/" className="btn btn-primary">
        <IconArrowLeft size={15} />
        Home
      </Link>
    </div>
  );
}
