import Link from "next/link";
import { IconArrowRight, IconCertificate } from "@tabler/icons-react";

export function EmptyCredentialsState() {
  return (
    <div
      className="card"
      style={{ textAlign: "center", padding: "3.5rem 1.5rem", borderStyle: "dashed" }}
    >
      <IconCertificate size={30} stroke={1.3} color="var(--faint)" />
      <h3 style={{ margin: "1rem 0 0.4rem" }}>No credentials yet</h3>
      <p className="muted" style={{ fontSize: "0.875rem", maxWidth: 340, margin: "0 auto 1.5rem" }}>
        Get a credential from a trusted issuer, then generate a zero-knowledge proof to verify it
        on-chain.
      </p>
      <a href="/verify" className="btn btn-primary btn-sm" style={{ display: "inline-flex" }}>
        Get a credential
        <IconArrowRight size={14} />
      </a>
      <p
        className="faint"
        style={{ fontSize: "0.75rem", maxWidth: 380, margin: "1.25rem auto 0", lineHeight: 1.6 }}
      >
        Credentials are stored only in this browser&apos;s local storage — clearing site data,
        switching browsers/devices, or private mode erases them.{" "}
        <Link href="/docs#storage" style={{ color: "var(--accent)", textDecoration: "underline" }}>
          Where your credentials live
        </Link>
      </p>
    </div>
  );
}
