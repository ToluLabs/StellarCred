import { IconLock, IconShieldCheck } from "@tabler/icons-react";
import { Badge } from "./Badge";
import { truncateHash } from "@/lib/format";

export interface CardField {
  label: string;
  value: string | null;
}

interface Props {
  issuer: string;
  type: string;
  holder: string;
  network?: string;
  fields: CardField[];
  proofHash?: string;
  validity?: string;
}

export function CredentialCard({
  issuer,
  type,
  holder,
  network = "stellar:testnet",
  fields,
  proofHash,
  validity,
}: Props) {
  return (
    <div
      style={{
        position: "relative",
        maxWidth: 400,
        width: "100%",
        /* gradient border via background on wrapper */
        padding: "1px",
        borderRadius: "20px",
        background:
          "linear-gradient(145deg, color-mix(in srgb, var(--accent) 35%, transparent) 0%, var(--border-strong) 40%, color-mix(in srgb, var(--accent) 15%, transparent) 100%)",
        boxShadow:
          "0 0 60px color-mix(in srgb, var(--accent) 8%, transparent), 0 24px 64px rgba(0,0,0,0.15)",
      }}
    >
      {/* glow orb behind card */}
      <div
        style={{
          position: "absolute",
          top: "30%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 200,
          height: 200,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, color-mix(in srgb, var(--accent) 18%, transparent) 0%, transparent 70%)",
          pointerEvents: "none",
          filter: "blur(20px)",
          zIndex: 0,
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          borderRadius: "19px",
          background: "var(--bg-raised)",
          overflow: "hidden",
          padding: "1.5rem",
        }}
      >
        {/* top shimmer strip */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "1px",
            background:
              "linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 40%, transparent) 40%, var(--border-strong) 60%, transparent)",
          }}
        />

        {/* header */}
        <div className="between" style={{ marginBottom: "1.25rem" }}>
          <div className="row" style={{ gap: "0.5rem" }}>
            <IconShieldCheck size={16} color="var(--accent)" stroke={1.8} />
            <span
              style={{
                fontSize: "0.72rem",
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--accent)",
              }}
            >
              {issuer}
            </span>
          </div>
          <Badge variant="verified" dot={false}>
            Verified
          </Badge>
        </div>

        <h2 style={{ marginBottom: "0.35rem", fontSize: "1.35rem" }}>{type}</h2>
        <div className="mono faint" style={{ marginBottom: "1.4rem", fontSize: "0.75rem" }}>
          {holder} · {network}
        </div>

        <div
          style={{
            background: "var(--bg-soft)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}
        >
          {fields.map((f, i) => (
            <div
              key={f.label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.65rem 0.9rem",
                borderTop: i === 0 ? "none" : "1px solid var(--border)",
              }}
            >
              <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>{f.label}</span>
              {f.value ? (
                <span className="mono accent" style={{ fontSize: "0.8rem" }}>
                  {f.value}
                </span>
              ) : (
                <span className="row faint" style={{ gap: "0.3rem", fontSize: "0.75rem" }}>
                  <IconLock size={11} />
                  Private
                </span>
              )}
            </div>
          ))}
        </div>

        {(proofHash || validity) && (
          <div
            style={{
              marginTop: "1.1rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span className="mono faint" style={{ fontSize: "0.72rem" }}>
              π {proofHash ? truncateHash(proofHash) : "—"}
            </span>
            {validity && (
              <span
                className="mono"
                style={{
                  fontSize: "0.72rem",
                  color: "var(--accent)",
                  background: "rgba(74,234,164,0.1)",
                  border: "1px solid rgba(74,234,164,0.25)",
                  padding: "0.15rem 0.5rem",
                  borderRadius: "999px",
                }}
              >
                {validity}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
