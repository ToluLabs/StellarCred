"use client";

import { useState } from "react";
import Link from "next/link";
import {
  IconArrowLeft,
  IconCheck,
  IconLoader2,
  IconAlertCircle,
  IconSend,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { Badge } from "@/components/Badge";

const VALID_CLAIM_TYPES = [
  "kyc",
  "age",
  "jurisdiction",
  "income",
  "funds",
  "accreditation",
  "employment",
] as const;

const CLAIM_LABELS: Record<string, string> = {
  kyc: "KYC",
  age: "Age",
  jurisdiction: "Jurisdiction",
  income: "Income",
  funds: "Funds",
  accreditation: "Accreditation",
  employment: "Employment",
};

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; id: number }
  | { kind: "error"; message: string };

export default function SubmitAppPage() {
  const [appName, setAppName] = useState("");
  const [description, setDescription] = useState("");
  const [requiredClaims, setRequiredClaims] = useState<string[]>([]);
  const [verifyUrl, setVerifyUrl] = useState("https://");
  const [contactEmail, setContactEmail] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  const [errors, setErrors] = useState<Record<string, string>>({});

  function toggleClaim(claim: string) {
    setRequiredClaims((prev) =>
      prev.includes(claim) ? prev.filter((c) => c !== claim) : [...prev, claim]
    );
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};

    if (!appName.trim()) {
      errs.appName = "App name is required";
    } else if (appName.trim().length > 120) {
      errs.appName = "App name must be at most 120 characters";
    }

    if (!description.trim()) {
      errs.description = "Description is required";
    } else if (description.trim().length > 2000) {
      errs.description = "Description must be at most 2000 characters";
    }

    if (requiredClaims.length === 0) {
      errs.requiredClaims = "Select at least one required claim type";
    }

    if (!verifyUrl.trim()) {
      errs.verifyUrl = "Verify URL is required";
    } else {
      try {
        const parsed = new URL(verifyUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          errs.verifyUrl = "Verify URL must use http or https";
        }
      } catch {
        errs.verifyUrl = "Verify URL must be a valid URL";
      }
    }

    if (!contactEmail.trim()) {
      errs.contactEmail = "Contact email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
      errs.contactEmail = "Enter a valid email address";
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setState({ kind: "submitting" });

    try {
      const res = await fetch("/api/apps/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appName: appName.trim(),
          description: description.trim(),
          requiredClaims,
          verifyUrl: verifyUrl.trim(),
          contactEmail: contactEmail.trim(),
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Submission failed (${res.status})`);
      }

      const data = await res.json();
      setState({ kind: "success", id: data.id });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Submission failed",
      });
    }
  }

  const fieldStyle = {
    width: "100%",
    padding: "0.65rem 0.9rem",
    borderRadius: "var(--radius)",
    border: "1px solid var(--border)",
    background: "var(--bg-raised)",
    color: "var(--text)",
    fontSize: "0.875rem",
  };

  const errorStyle = {
    fontSize: "0.75rem",
    color: "var(--danger)",
    marginTop: "0.3rem",
  };

  if (state.kind === "success") {
    return (
      <div style={{ maxWidth: "36rem", margin: "0 auto", padding: "2rem 0" }}>
        <div className="card" style={{ textAlign: "center", padding: "3rem 2rem" }}>
          <div
            style={{
              width: "3.5rem",
              height: "3.5rem",
              borderRadius: "50%",
              background: "rgba(62,207,142,0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 1.5rem",
            }}
          >
            <IconCheck size={24} color="var(--accent)" stroke={2.5} />
          </div>
          <h2 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>
            Submission received
          </h2>
          <p
            className="muted"
            style={{ fontSize: "0.875rem", lineHeight: 1.7, marginBottom: "2rem" }}
          >
            Your app <strong>{appName}</strong> has been submitted for review.
            Our team will review the submission and verify the integration before
            listing it in the gallery. You&apos;ll be notified at{" "}
            <span className="mono">{contactEmail}</span>.
          </p>
          <div className="row" style={{ gap: "0.75rem", justifyContent: "center" }}>
            <Link href="/apps" className="btn btn-primary">
              Back to Apps
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "42rem", margin: "0 auto", padding: "2rem 0" }}>
      <div style={{ marginBottom: "2rem" }}>
        <Link
          href="/apps"
          className="row faint"
          style={{
            fontSize: "0.8125rem",
            gap: "0.35rem",
            marginBottom: "0.75rem",
            textDecoration: "none",
          }}
        >
          <IconArrowLeft size={13} /> Apps
        </Link>
        <h1 style={{ fontSize: "2rem" }}>Submit an App</h1>
        <p
          className="muted"
          style={{ fontSize: "0.875rem", marginTop: "0.5rem", lineHeight: 1.6 }}
        >
          List your StellarCred integration in the Apps gallery. Submissions are
          reviewed before being published.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="card" style={{ padding: "2rem" }}>
        <div style={{ marginBottom: "1.5rem" }}>
          <label className="field-label" htmlFor="app-name" style={{ display: "block", marginBottom: "0.4rem" }}>
            App name *
          </label>
          <input id="app-name" value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="e.g. LendFi" maxLength={120} style={fieldStyle} />
          {errors.appName && <p style={errorStyle}>{errors.appName}</p>}
        </div>

        <div style={{ marginBottom: "1.5rem" }}>
          <label className="field-label" htmlFor="app-description" style={{ display: "block", marginBottom: "0.4rem" }}>
            Description *
          </label>
          <textarea id="app-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe what your app does and how it uses StellarCred credentials..." rows={4} maxLength={2000} style={{ ...fieldStyle, resize: "vertical", minHeight: "5rem" }} />
          <div className="faint" style={{ fontSize: "0.72rem", marginTop: "0.3rem", textAlign: "right" }}>
            {description.length}/2000
          </div>
          {errors.description && <p style={errorStyle}>{errors.description}</p>}
        </div>

        <div style={{ marginBottom: "1.5rem" }}>
          <label className="field-label" style={{ display: "block", marginBottom: "0.5rem" }}>
            Required claims *
          </label>
          <p className="faint" style={{ fontSize: "0.8125rem", marginBottom: "0.75rem", lineHeight: 1.5 }}>
            Which StellarCred credential types does your app gate access on?
          </p>
          <div className="row" style={{ gap: "0.4rem", flexWrap: "wrap" }}>
            {VALID_CLAIM_TYPES.map((claim) => {
              const isActive = requiredClaims.includes(claim);
              return (
                <button
                  key={claim}
                  type="button"
                  onClick={() => toggleClaim(claim)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    padding: "0.4rem 0.8rem",
                    borderRadius: "999px",
                    fontSize: "0.75rem",
                    fontWeight: 500,
                    border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}`,
                    background: isActive ? "rgba(62,207,142,0.12)" : "transparent",
                    color: isActive ? "var(--accent)" : "var(--muted)",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                  }}
                >
                  {isActive ? <IconX size={12} stroke={2.5} /> : <IconPlus size={12} stroke={2} />}
                  {CLAIM_LABELS[claim]}
                </button>
              );
            })}
          </div>
          {requiredClaims.length > 0 && (
            <div className="row" style={{ gap: "0.35rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
              {requiredClaims.map((claim) => (
                <Badge key={claim} variant="verified">
                  {CLAIM_LABELS[claim] || claim}
                </Badge>
              ))}
            </div>
          )}
          {errors.requiredClaims && <p style={errorStyle}>{errors.requiredClaims}</p>}
        </div>

        <div style={{ marginBottom: "1.5rem" }}>
          <label className="field-label" htmlFor="verify-url" style={{ display: "block", marginBottom: "0.4rem" }}>
            Verify URL *
          </label>
          <input id="verify-url" value={verifyUrl} onChange={(e) => setVerifyUrl(e.target.value)} placeholder="https://yourapp.example.com/verify" style={fieldStyle} />
          <p className="faint" style={{ fontSize: "0.75rem", marginTop: "0.3rem", lineHeight: 1.5 }}>
            Users will be redirected here to verify credentials. Must be a valid http or https URL.
          </p>
          {errors.verifyUrl && <p style={errorStyle}>{errors.verifyUrl}</p>}
        </div>

        <div style={{ marginBottom: "2rem" }}>
          <label className="field-label" htmlFor="contact-email" style={{ display: "block", marginBottom: "0.4rem" }}>
            Contact email *
          </label>
          <input id="contact-email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="integrations@yourapp.example.com" style={fieldStyle} />
          <p className="faint" style={{ fontSize: "0.75rem", marginTop: "0.3rem", lineHeight: 1.5 }}>
            We&apos;ll use this to notify you about your submission status.
          </p>
          {errors.contactEmail && <p style={errorStyle}>{errors.contactEmail}</p>}
        </div>

        {state.kind === "error" && (
          <div
            style={{
              padding: "0.85rem 1rem",
              borderRadius: "var(--radius)",
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.25)",
              fontSize: "0.875rem",
              color: "var(--danger)",
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              marginBottom: "1.5rem",
            }}
          >
            <IconAlertCircle size={16} />
            {state.message}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={state.kind === "submitting"}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            opacity: state.kind === "submitting" ? 0.6 : 1,
          }}
        >
          {state.kind === "submitting" ? (
            <>
              <IconLoader2 size={16} className="spin" />
              Submitting…
            </>
          ) : (
            <>
              <IconSend size={16} />
              Submit for review
            </>
          )}
        </button>
      </form>
    </div>
  );
}
