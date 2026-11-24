"use client";

import { useState } from "react";
import { IconSparkles, IconCheck } from "@tabler/icons-react";
import {
  CREDENTIAL_TEMPLATES,
  type CredentialTemplate,
} from "@/lib/credential-templates";
import type { CredentialType } from "@/lib/stellar";

interface CredentialTemplateGalleryProps {
  selectedTemplateId?: string | null;
  allowedTypes?: CredentialType[];
  onSelectTemplate: (template: CredentialTemplate) => void;
}

export function CredentialTemplateGallery({
  selectedTemplateId,
  allowedTypes,
  onSelectTemplate,
}: CredentialTemplateGalleryProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  const filteredTemplates = CREDENTIAL_TEMPLATES.filter((template) => {
    if (allowedTypes && allowedTypes.length > 0 && !allowedTypes.includes(template.type)) {
      return false;
    }
    if (selectedCategory !== "all" && template.category !== selectedCategory) {
      return false;
    }
    return true;
  });

  return (
    <div
      style={{
        marginBottom: "1.75rem",
        padding: "1.25rem",
        borderRadius: "var(--radius)",
        background: "rgba(255, 255, 255, 0.02)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="between"
        style={{
          alignItems: "center",
          marginBottom: "1rem",
          flexWrap: "wrap",
          gap: "0.75rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <IconSparkles size={18} style={{ color: "var(--accent)" }} />
          <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: 0 }}>
            Credential Templates Gallery
          </h2>
          <span
            style={{
              fontSize: "0.75rem",
              padding: "0.15rem 0.5rem",
              borderRadius: "999px",
              background: "rgba(255, 255, 255, 0.08)",
              color: "var(--muted)",
            }}
          >
            {filteredTemplates.length} presets
          </span>
        </div>

        {/* Category filters */}
        <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
          {(["all", "finance", "compliance", "identity", "work"] as const).map(
            (cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                style={{
                  fontSize: "0.75rem",
                  padding: "0.25rem 0.6rem",
                  borderRadius: "var(--radius)",
                  border:
                    selectedCategory === cat
                      ? "1px solid var(--accent)"
                      : "1px solid rgba(255, 255, 255, 0.08)",
                  background:
                    selectedCategory === cat
                      ? "rgba(100, 200, 255, 0.12)"
                      : "transparent",
                  color:
                    selectedCategory === cat
                      ? "var(--text)"
                      : "var(--muted)",
                  cursor: "pointer",
                  textTransform: "capitalize",
                }}
              >
                {cat}
              </button>
            ),
          )}
        </div>
      </div>

      <p
        style={{
          fontSize: "0.8125rem",
          color: "var(--muted)",
          marginTop: 0,
          marginBottom: "1rem",
        }}
      >
        Pick a pre-configured template to automatically prefill claim type, thresholds, and default params. All values remain fully editable before issuance.
      </p>

      {filteredTemplates.length === 0 ? (
        <div
          style={{
            padding: "1rem",
            textAlign: "center",
            color: "var(--muted)",
            fontSize: "0.8125rem",
          }}
        >
          No templates match the selected filter or registered issuer capability.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "0.75rem",
          }}
        >
          {filteredTemplates.map((template) => {
            const isSelected = selectedTemplateId === template.id;
            return (
              <div
                key={template.id}
                onClick={() => onSelectTemplate(template)}
                style={{
                  padding: "0.85rem 1rem",
                  borderRadius: "var(--radius)",
                  border: isSelected
                    ? "1px solid var(--accent)"
                    : "1px solid var(--border)",
                  background: isSelected
                    ? "rgba(100, 200, 255, 0.07)"
                    : "rgba(255, 255, 255, 0.03)",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  transition: "all 0.15s ease",
                }}
              >
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "0.35rem",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.7rem",
                        fontWeight: 600,
                        padding: "0.15rem 0.45rem",
                        borderRadius: "4px",
                        background: "rgba(255, 255, 255, 0.08)",
                        color: "var(--accent)",
                        textTransform: "uppercase",
                      }}
                    >
                      {template.badge}
                    </span>
                    {isSelected && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.2rem",
                          color: "var(--accent)",
                          fontSize: "0.75rem",
                        }}
                      >
                        <IconCheck size={14} /> Applied
                      </span>
                    )}
                  </div>
                  <strong
                    style={{
                      fontSize: "0.875rem",
                      display: "block",
                      marginBottom: "0.25rem",
                      color: isSelected ? "var(--accent)" : "var(--text)",
                    }}
                  >
                    {template.name}
                  </strong>
                  <p
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--muted)",
                      margin: 0,
                      lineHeight: 1.4,
                    }}
                  >
                    {template.description}
                  </p>
                </div>

                <div
                  style={{
                    marginTop: "0.75rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: "0.7rem",
                    color: "var(--muted)",
                    borderTop: "1px solid rgba(255, 255, 255, 0.05)",
                    paddingTop: "0.5rem",
                  }}
                >
                  <span>Type: <strong style={{ color: "var(--text)" }}>{template.type}</strong></span>
                  <span>Expiry: {template.defaultExpiry}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
