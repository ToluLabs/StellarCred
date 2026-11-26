"use client";

import { useState, useMemo, useCallback } from "react";
import CopyButton from "./CopyButton";
import {
  SCHEMA_PRESETS,
  buildJsonLdSchema,
  buildSamplePayload,
  parseJsonLdSchema,
  toSchemaSlug,
  validateSamplePayload,
  validateSchemaDraft,
  type AttributeDataType,
  type CredentialSchemaDraft,
  type SchemaAttribute,
  type ZkConstraintType,
} from "@/lib/credential-schema";

type OutputTab = "preview" | "parser" | "payload";

const ATTRIBUTE_TYPES: { value: AttributeDataType; label: string }[] = [
  { value: "string", label: "string (xsd:string)" },
  { value: "integer", label: "integer (xsd:integer)" },
  { value: "boolean", label: "boolean (xsd:boolean)" },
  { value: "date", label: "date (xsd:date)" },
  { value: "isoCountryCode", label: "isoCountryCode (ISO-3166)" },
  { value: "currencyAmount", label: "currencyAmount (USD int)" },
];

const ZK_CONSTRAINTS: { value: ZkConstraintType; label: string }[] = [
  { value: "none", label: "None (attestation only)" },
  { value: "minThreshold", label: "minThreshold (>= value)" },
  { value: "maxThreshold", label: "maxThreshold (<= value)" },
  { value: "range", label: "range (min .. max)" },
  { value: "allowlist", label: "allowlist (mode: 1)" },
  { value: "denylist", label: "denylist (mode: 0)" },
  { value: "equality", label: "equality (exact match)" },
];

const inputStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: "0.84rem",
  background: "var(--input)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  padding: "0.55rem 0.7rem",
  color: "var(--text)",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const monoInputStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: "var(--font-mono), monospace",
};

function cloneDraft(draft: CredentialSchemaDraft): CredentialSchemaDraft {
  return {
    ...draft,
    attributes: draft.attributes.map((a) => ({ ...a })),
  };
}

let nextAttrCounter = 1;

export default function CredentialSchemaPlayground() {
  const [draft, setDraft] = useState<CredentialSchemaDraft>(() =>
    cloneDraft(SCHEMA_PRESETS[0].draft),
  );
  const [activeTab, setActiveTab] = useState<OutputTab>("preview");
  const [rawJsonLdInput, setRawJsonLdInput] = useState<string>(() =>
    JSON.stringify(buildJsonLdSchema(SCHEMA_PRESETS[0].draft), null, 2),
  );
  const [samplePayloadInput, setSamplePayloadInput] = useState<string>(() =>
    JSON.stringify(buildSamplePayload(SCHEMA_PRESETS[0].draft), null, 2),
  );

  const validation = useMemo(() => validateSchemaDraft(draft), [draft]);
  const generatedSchema = useMemo(() => buildJsonLdSchema(draft), [draft]);
  const generatedJson = useMemo(() => JSON.stringify(generatedSchema, null, 2), [generatedSchema]);
  const parseResult = useMemo(() => parseJsonLdSchema(rawJsonLdInput), [rawJsonLdInput]);
  const payloadResult = useMemo(
    () => validateSamplePayload(draft, samplePayloadInput),
    [draft, samplePayloadInput],
  );

  const loadPreset = useCallback((presetId: string) => {
    const preset = SCHEMA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const cloned = cloneDraft(preset.draft);
    setDraft(cloned);
    setRawJsonLdInput(JSON.stringify(buildJsonLdSchema(cloned), null, 2));
    setSamplePayloadInput(JSON.stringify(buildSamplePayload(cloned), null, 2));
  }, []);

  const addAttribute = useCallback(() => {
    const id = `attr-${Date.now()}-${nextAttrCounter++}`;
    setDraft((prev) => ({
      ...prev,
      attributes: [
        ...prev.attributes,
        {
          id,
          name: `attribute${prev.attributes.length + 1}`,
          type: "string",
          required: true,
          description: "",
          zkConstraint: "none",
        },
      ],
    }));
  }, []);

  const updateAttribute = useCallback((id: string, patch: Partial<SchemaAttribute>) => {
    setDraft((prev) => ({
      ...prev,
      attributes: prev.attributes.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  }, []);

  const removeAttribute = useCallback((id: string) => {
    setDraft((prev) => ({
      ...prev,
      attributes: prev.attributes.filter((a) => a.id !== id),
    }));
  }, []);

  const syncPreviewToParser = useCallback(() => {
    setRawJsonLdInput(generatedJson);
    setActiveTab("parser");
  }, [generatedJson]);

  const loadParsedIntoBuilder = useCallback(() => {
    if (!parseResult.ok || !parseResult.draft) return;
    const cloned = cloneDraft(parseResult.draft);
    setDraft(cloned);
    setSamplePayloadInput(JSON.stringify(buildSamplePayload(cloned), null, 2));
    setActiveTab("preview");
  }, [parseResult]);

  const regenerateSamplePayload = useCallback(() => {
    setSamplePayloadInput(JSON.stringify(buildSamplePayload(draft), null, 2));
  }, [draft]);

  const downloadSchema = useCallback(() => {
    const blob = new Blob([generatedJson], {
      type: "application/ld+json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${toSchemaSlug(draft.name)}.jsonld`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [generatedJson, draft.name]);

  return (
    <section style={{ marginTop: "3rem" }} aria-labelledby="schema-playground-heading">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: "0.75rem",
          marginBottom: "0.5rem",
        }}
      >
        <h2
          id="schema-playground-heading"
          style={{ fontSize: "1.25rem", margin: 0, color: "var(--text)" }}
        >
          Credential Schema Playground
        </h2>
        <span
          data-testid="schema-validation-badge"
          style={{
            fontFamily: "var(--font-mono), monospace",
            fontSize: "0.75rem",
            padding: "0.2rem 0.6rem",
            borderRadius: "999px",
            background: validation.valid ? "rgba(62, 207, 142, 0.12)" : "rgba(240, 96, 77, 0.12)",
            color: validation.valid ? "var(--accent)" : "var(--danger)",
            border:
              "1px solid " +
              (validation.valid ? "rgba(62, 207, 142, 0.25)" : "rgba(240, 96, 77, 0.3)"),
          }}
        >
          {validation.valid
            ? validation.warnings.length > 0
              ? `Valid (${validation.warnings.length} warning${validation.warnings.length === 1 ? "" : "s"})`
              : "Valid JSON-LD"
            : `${validation.errors.length} error${validation.errors.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <p className="muted" style={{ fontSize: "0.95rem", lineHeight: 1.7, marginBottom: "1rem" }}>
        Define custom credential attribute types and StellarCred ZK constraints, preview the
        generated W3C JSON-LD schema, and test live parsing and sample payloads.
      </p>

      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "1.25rem",
          display: "flex",
          flexDirection: "column",
          gap: "1.25rem",
        }}
      >
        {/* Preset bar */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span
            style={{
              fontSize: "0.78rem",
              color: "var(--faint)",
              fontWeight: 600,
              marginRight: "0.25rem",
            }}
          >
            Presets:
          </span>
          {SCHEMA_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => loadPreset(preset.id)}
              style={{
                fontFamily: "var(--font-mono), monospace",
                fontSize: "0.75rem",
                padding: "0.3rem 0.65rem",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "var(--input)",
                color: "var(--muted)",
                cursor: "pointer",
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {/* Schema metadata */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
            gap: "0.75rem",
          }}
        >
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.3rem",
            }}
          >
            <span
              style={{
                fontSize: "0.78rem",
                color: "var(--muted)",
                fontWeight: 500,
              }}
            >
              Schema Name
            </span>
            <input
              aria-label="Schema Name"
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="CustomCredential"
              style={monoInputStyle}
            />
          </label>

          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.3rem",
            }}
          >
            <span
              style={{
                fontSize: "0.78rem",
                color: "var(--muted)",
                fontWeight: 500,
              }}
            >
              Claim Symbol (1–9 chars)
            </span>
            <input
              aria-label="Claim Symbol"
              type="text"
              value={draft.claimSymbol}
              onChange={(e) => setDraft((prev) => ({ ...prev, claimSymbol: e.target.value }))}
              placeholder="funds"
              style={monoInputStyle}
            />
          </label>

          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.3rem",
            }}
          >
            <span
              style={{
                fontSize: "0.78rem",
                color: "var(--muted)",
                fontWeight: 500,
              }}
            >
              Version
            </span>
            <input
              aria-label="Schema Version"
              type="text"
              value={draft.version}
              onChange={(e) => setDraft((prev) => ({ ...prev, version: e.target.value }))}
              placeholder="1.0.0"
              style={monoInputStyle}
            />
          </label>

          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.3rem",
            }}
          >
            <span
              style={{
                fontSize: "0.78rem",
                color: "var(--muted)",
                fontWeight: 500,
              }}
            >
              Default Expiry (days)
            </span>
            <input
              aria-label="Default Expiry Days"
              type="number"
              min={1}
              value={draft.defaultExpiryDays}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  defaultExpiryDays: Number(e.target.value),
                }))
              }
              style={monoInputStyle}
            />
          </label>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          <span
            style={{
              fontSize: "0.78rem",
              color: "var(--muted)",
              fontWeight: 500,
            }}
          >
            Description
          </span>
          <input
            aria-label="Schema Description"
            type="text"
            value={draft.description}
            onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="Describe what this credential attests..."
            style={inputStyle}
          />
        </label>

        {/* Attributes builder */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontSize: "0.85rem",
                fontWeight: 600,
                color: "var(--text)",
              }}
            >
              Credential Subject Attributes ({draft.attributes.length})
            </span>
            <button
              type="button"
              onClick={addAttribute}
              style={{
                fontFamily: "var(--font-display), sans-serif",
                fontWeight: 600,
                fontSize: "0.8rem",
                background: "var(--accent)",
                color: "var(--on-accent)",
                border: "none",
                borderRadius: "var(--radius-sm)",
                padding: "0.4rem 0.85rem",
                cursor: "pointer",
              }}
            >
              + Add Attribute
            </button>
          </div>

          {draft.attributes.map((attr, idx) => (
            <div
              key={attr.id}
              data-testid={`attribute-row-${idx}`}
              style={{
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                padding: "0.85rem",
                background: "rgba(255, 255, 255, 0.015)",
                display: "flex",
                flexDirection: "column",
                gap: "0.65rem",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "0.6rem",
                  alignItems: "end",
                }}
              >
                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.25rem",
                  }}
                >
                  <span style={{ fontSize: "0.74rem", color: "var(--faint)" }}>Attribute Name</span>
                  <input
                    aria-label={`Attribute ${idx + 1} Name`}
                    type="text"
                    value={attr.name}
                    onChange={(e) => updateAttribute(attr.id, { name: e.target.value })}
                    placeholder="e.g. balanceUsd"
                    style={monoInputStyle}
                  />
                </label>

                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.25rem",
                  }}
                >
                  <span style={{ fontSize: "0.74rem", color: "var(--faint)" }}>Data Type</span>
                  <select
                    aria-label={`Attribute ${idx + 1} Type`}
                    value={attr.type}
                    onChange={(e) =>
                      updateAttribute(attr.id, {
                        type: e.target.value as AttributeDataType,
                      })
                    }
                    style={{ ...monoInputStyle, cursor: "pointer" }}
                  >
                    {ATTRIBUTE_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.25rem",
                  }}
                >
                  <span style={{ fontSize: "0.74rem", color: "var(--faint)" }}>ZK Constraint</span>
                  <select
                    aria-label={`Attribute ${idx + 1} Constraint`}
                    value={attr.zkConstraint}
                    onChange={(e) =>
                      updateAttribute(attr.id, {
                        zkConstraint: e.target.value as ZkConstraintType,
                      })
                    }
                    style={{ ...monoInputStyle, cursor: "pointer" }}
                  >
                    {ZK_CONSTRAINTS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "0.5rem",
                    paddingBottom: "0.3rem",
                  }}
                >
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      fontSize: "0.78rem",
                      color: "var(--muted)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={attr.required}
                      onChange={(e) => updateAttribute(attr.id, { required: e.target.checked })}
                    />
                    Required
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove attribute ${attr.name || idx + 1}`}
                    onClick={() => removeAttribute(attr.id)}
                    style={{
                      fontSize: "0.75rem",
                      background: "transparent",
                      color: "var(--danger)",
                      border: "1px solid rgba(240, 96, 77, 0.3)",
                      borderRadius: "var(--radius-sm)",
                      padding: "0.25rem 0.55rem",
                      cursor: "pointer",
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>

              {/* Constraint parameters */}
              {(attr.zkConstraint === "minThreshold" ||
                attr.zkConstraint === "maxThreshold" ||
                attr.zkConstraint === "equality") && (
                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.25rem",
                  }}
                >
                  <span style={{ fontSize: "0.74rem", color: "var(--faint)" }}>
                    {attr.zkConstraint === "equality" ? "Expected Value" : "Threshold Value"}
                  </span>
                  <input
                    aria-label={`Attribute ${idx + 1} Constraint Value`}
                    type="text"
                    value={attr.constraintValue ?? ""}
                    onChange={(e) =>
                      updateAttribute(attr.id, {
                        constraintValue: e.target.value,
                      })
                    }
                    placeholder={attr.zkConstraint === "equality" ? "true" : "50000"}
                    style={monoInputStyle}
                  />
                </label>
              )}

              {attr.zkConstraint === "range" && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "0.6rem",
                  }}
                >
                  <label
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.25rem",
                    }}
                  >
                    <span style={{ fontSize: "0.74rem", color: "var(--faint)" }}>Min Value</span>
                    <input
                      aria-label={`Attribute ${idx + 1} Min Value`}
                      type="text"
                      value={attr.constraintValue ?? ""}
                      onChange={(e) =>
                        updateAttribute(attr.id, {
                          constraintValue: e.target.value,
                        })
                      }
                      placeholder="18"
                      style={monoInputStyle}
                    />
                  </label>
                  <label
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.25rem",
                    }}
                  >
                    <span style={{ fontSize: "0.74rem", color: "var(--faint)" }}>Max Value</span>
                    <input
                      aria-label={`Attribute ${idx + 1} Max Value`}
                      type="text"
                      value={attr.constraintMax ?? ""}
                      onChange={(e) =>
                        updateAttribute(attr.id, {
                          constraintMax: e.target.value,
                        })
                      }
                      placeholder="65"
                      style={monoInputStyle}
                    />
                  </label>
                </div>
              )}

              {(attr.zkConstraint === "allowlist" || attr.zkConstraint === "denylist") && (
                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.25rem",
                  }}
                >
                  <span style={{ fontSize: "0.74rem", color: "var(--faint)" }}>
                    Values (comma-separated)
                  </span>
                  <input
                    aria-label={`Attribute ${idx + 1} Constraint List`}
                    type="text"
                    value={attr.constraintList ?? ""}
                    onChange={(e) =>
                      updateAttribute(attr.id, {
                        constraintList: e.target.value,
                      })
                    }
                    placeholder="408, 364, 760"
                    style={monoInputStyle}
                  />
                </label>
              )}
            </div>
          ))}
        </div>

        {/* Instant validation feedback */}
        {(validation.errors.length > 0 || validation.warnings.length > 0) && (
          <div
            role="status"
            style={{
              fontFamily: "var(--font-mono), monospace",
              fontSize: "0.78rem",
              background:
                validation.errors.length > 0
                  ? "rgba(240, 96, 77, 0.08)"
                  : "rgba(245, 158, 11, 0.08)",
              border:
                "1px solid " +
                (validation.errors.length > 0
                  ? "rgba(240, 96, 77, 0.25)"
                  : "rgba(245, 158, 11, 0.25)"),
              borderRadius: "var(--radius-sm)",
              padding: "0.75rem 1rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.35rem",
            }}
          >
            {validation.errors.map((err, i) => (
              <div key={`err-${i}`} style={{ color: "var(--danger)" }}>
                Error [{err.field}]: {err.message}
              </div>
            ))}
            {validation.warnings.map((warn, i) => (
              <div key={`warn-${i}`} style={{ color: "#f59e0b" }}>
                Warning [{warn.field}]: {warn.message}
              </div>
            ))}
          </div>
        )}

        {/* Output / Live Testing Tabs */}
        <div>
          <div
            role="tablist"
            aria-label="Schema playground output tabs"
            style={{
              display: "flex",
              gap: "0.35rem",
              borderBottom: "1px solid var(--border)",
              paddingBottom: "0.65rem",
              marginBottom: "1rem",
              flexWrap: "wrap",
            }}
          >
            {(
              [
                { id: "preview", label: "JSON-LD Preview" },
                { id: "parser", label: "Live JSON-LD Parser" },
                { id: "payload", label: "Test Sample Payload" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: "0.78rem",
                  padding: "0.4rem 0.75rem",
                  borderRadius: "var(--radius-sm)",
                  border: "none",
                  cursor: "pointer",
                  background: activeTab === tab.id ? "var(--accent)" : "transparent",
                  color: activeTab === tab.id ? "var(--on-accent)" : "var(--muted)",
                  fontWeight: activeTab === tab.id ? 600 : 400,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "preview" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}
              >
                <span style={{ fontSize: "0.8rem", color: "var(--faint)" }}>
                  Live generated W3C Verifiable Credential JSON-LD schema
                </span>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    type="button"
                    onClick={syncPreviewToParser}
                    style={{
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: "0.75rem",
                      background: "var(--input)",
                      color: "var(--text)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      padding: "0.3rem 0.65rem",
                      cursor: "pointer",
                    }}
                  >
                    Open in Parser
                  </button>
                  <button
                    type="button"
                    onClick={downloadSchema}
                    style={{
                      fontFamily: "var(--font-mono), monospace",
                      fontSize: "0.75rem",
                      background: "var(--input)",
                      color: "var(--text)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      padding: "0.3rem 0.65rem",
                      cursor: "pointer",
                    }}
                  >
                    Download .jsonld
                  </button>
                </div>
              </div>
              <div
                style={{
                  position: "relative",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: "0.78rem",
                  background: "var(--input)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-sm)",
                  padding: "0.85rem 1rem",
                  overflowX: "auto",
                  maxHeight: 380,
                  overflowY: "auto",
                  lineHeight: 1.6,
                  whiteSpace: "pre",
                }}
              >
                <code data-testid="jsonld-preview-code" style={{ color: "var(--accent)" }}>
                  {generatedJson}
                </code>
                <div style={{ position: "absolute", top: "0.5rem", right: "0.5rem" }}>
                  <CopyButton value={generatedJson} />
                </div>
              </div>
            </div>
          )}

          {activeTab === "parser" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}
              >
                <span style={{ fontSize: "0.8rem", color: "var(--faint)" }}>
                  Paste or edit raw JSON-LD to validate StellarCred constraint structures live
                </span>
                <button
                  type="button"
                  disabled={!parseResult.ok}
                  onClick={loadParsedIntoBuilder}
                  style={{
                    fontFamily: "var(--font-display), sans-serif",
                    fontWeight: 600,
                    fontSize: "0.78rem",
                    background: parseResult.ok ? "var(--accent)" : "var(--input)",
                    color: parseResult.ok ? "var(--on-accent)" : "var(--faint)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "0.35rem 0.75rem",
                    cursor: parseResult.ok ? "pointer" : "not-allowed",
                  }}
                >
                  Load into Builder
                </button>
              </div>
              <textarea
                aria-label="Raw JSON-LD Input"
                value={rawJsonLdInput}
                onChange={(e) => setRawJsonLdInput(e.target.value)}
                rows={12}
                style={{
                  ...monoInputStyle,
                  lineHeight: 1.55,
                  resize: "vertical",
                }}
              />
              <div
                data-testid="parser-result"
                style={{
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: "0.78rem",
                  background: parseResult.ok
                    ? "rgba(62, 207, 142, 0.06)"
                    : "rgba(240, 96, 77, 0.08)",
                  border:
                    "1px solid " +
                    (parseResult.ok ? "rgba(62, 207, 142, 0.2)" : "rgba(240, 96, 77, 0.25)"),
                  borderRadius: "var(--radius-sm)",
                  padding: "0.75rem 1rem",
                  color: parseResult.ok ? "var(--text)" : "var(--danger)",
                }}
              >
                {parseResult.ok ? (
                  <div>
                    Parsed cleanly: {parseResult.draft?.name} (symbol:{" "}
                    {parseResult.draft?.claimSymbol}, {parseResult.draft?.attributes.length}{" "}
                    attribute
                    {parseResult.draft?.attributes.length === 1 ? "" : "s"})
                  </div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.3rem",
                    }}
                  >
                    {parseResult.errors.map((err, i) => (
                      <div key={i}>
                        Error [{err.field}]: {err.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "payload" && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}
              >
                <span style={{ fontSize: "0.8rem", color: "var(--faint)" }}>
                  Test a sample credentialSubject JSON payload against your schema and ZK
                  constraints
                </span>
                <button
                  type="button"
                  onClick={regenerateSamplePayload}
                  style={{
                    fontFamily: "var(--font-mono), monospace",
                    fontSize: "0.75rem",
                    background: "var(--input)",
                    color: "var(--text)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "0.3rem 0.65rem",
                    cursor: "pointer",
                  }}
                >
                  Generate Valid Sample
                </button>
              </div>
              <textarea
                aria-label="Sample Credential Payload JSON"
                value={samplePayloadInput}
                onChange={(e) => setSamplePayloadInput(e.target.value)}
                rows={7}
                style={{
                  ...monoInputStyle,
                  lineHeight: 1.55,
                  resize: "vertical",
                }}
              />
              <div
                data-testid="payload-test-result"
                style={{
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: "0.78rem",
                  background: payloadResult.ok
                    ? "rgba(62, 207, 142, 0.06)"
                    : "rgba(240, 96, 77, 0.08)",
                  border:
                    "1px solid " +
                    (payloadResult.ok ? "rgba(62, 207, 142, 0.2)" : "rgba(240, 96, 77, 0.25)"),
                  borderRadius: "var(--radius-sm)",
                  padding: "0.75rem 1rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.35rem",
                }}
              >
                {payloadResult.parseError ? (
                  <div style={{ color: "var(--danger)" }}>{payloadResult.parseError}</div>
                ) : (
                  payloadResult.checks.map((check) => (
                    <div
                      key={check.attribute}
                      style={{
                        color: check.passed ? "var(--accent)" : "var(--danger)",
                      }}
                    >
                      {check.passed ? "PASS" : "FAIL"} {check.attribute}: {check.reason}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
