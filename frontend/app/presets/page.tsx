"use client";

// Selective disclosure presets (#386): a holder defines a named bundle of
// claim types (+ thresholds) once — e.g. "Investor onboarding" meaning
// kyc + accreditation + jurisdiction — and shares one link a protocol can
// verify end to end via the SDK's `verifyPreset` (see /verify-preset).

import { useMemo, useState } from "react";
import { WalletButton } from "@/components/WalletButton";
import CopyButton from "@/components/CopyButton";
import { useCredentialSync, TYPE_META } from "@/lib/credential";
import { CLAIM_TYPES, type ClaimType } from "@stellarcred/sdk";
import {
  loadPresets,
  savePreset,
  removePreset,
  buildPresetShareUrl,
  type Preset,
  type PresetClaim,
} from "@/lib/presets";

export default function PresetsPage() {
  const credentials = useCredentialSync();
  const [presets, setPresets] = useState<Preset[]>(() => loadPresets());
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [thresholds, setThresholds] = useState<Record<string, string>>({});

  // Only claim types the holder actually has proved something for, AND that
  // the SDK's verifyPreset (= hasClaims) can actually check, make sense in a
  // preset — "employment" is a proved credential type but not yet in the
  // SDK's CLAIM_TYPES, so it can't be part of a verifiable preset.
  const heldTypes = useMemo(() => {
    const verifiable: readonly string[] = CLAIM_TYPES;
    const set = new Set<ClaimType>();
    for (const c of credentials) {
      if (verifiable.includes(c.type)) set.add(c.type as ClaimType);
    }
    return Array.from(set);
  }, [credentials]);

  function toggle(type: ClaimType) {
    setSelected((s) => ({ ...s, [type]: !s[type] }));
  }

  function reset() {
    setName("");
    setSelected({});
    setThresholds({});
  }

  function onSave() {
    const claims: PresetClaim[] = heldTypes
      .filter((t) => selected[t])
      .map((t) => {
        const raw = thresholds[t];
        const n = raw ? Number(raw) : undefined;
        return n !== undefined && Number.isFinite(n) ? { type: t, minThreshold: n } : { type: t };
      });
    if (!name.trim() || claims.length === 0) return;
    setPresets(savePreset({ name: name.trim(), claims }));
    reset();
  }

  function onDelete(id: string) {
    setPresets(removePreset(id));
  }

  function shareUrl(preset: Preset): string {
    const base = typeof window !== "undefined" ? window.location.origin : "https://stellarcred.xyz";
    return buildPresetShareUrl(base, preset.name, preset.claims);
  }

  const canSave = name.trim().length > 0 && heldTypes.some((t) => selected[t]);

  return (
    <>
      <div className="between" style={{ marginBottom: "2rem" }}>
        <div>
          <span className="eyebrow">Holder</span>
          <h1 style={{ fontSize: "2rem", marginTop: "0.35rem" }}>
            Selective disclosure presets
          </h1>
        </div>
        <WalletButton />
      </div>

      <div className="grid grid-2" style={{ alignItems: "start", gap: "1.5rem" }}>
        <div className="card">
          <span className="eyebrow" style={{ marginBottom: "0.5rem", display: "block" }}>
            New preset
          </span>

          <label className="field-label" htmlFor="preset-name">
            Name
          </label>
          <input
            id="preset-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Investor onboarding"
          />

          <label className="field-label" style={{ marginTop: "1.25rem" }}>
            Claims to include
          </label>
          {heldTypes.length === 0 ? (
            <p className="faint" style={{ fontSize: "0.8125rem", marginTop: "0.35rem" }}>
              You don&apos;t have any proved credentials yet — get one on the
              holder page first.
            </p>
          ) : (
            <div style={{ marginTop: "0.5rem" }}>
              {heldTypes.map((type) => {
                const meta = TYPE_META[type];
                const needsThreshold =
                  type === "age" || type === "income" || type === "funds" || type === "accreditation";
                return (
                  <div
                    key={type}
                    className="row"
                    style={{ gap: "0.6rem", alignItems: "center", marginBottom: "0.5rem" }}
                  >
                    <input
                      type="checkbox"
                      id={`preset-claim-${type}`}
                      checked={!!selected[type]}
                      onChange={() => toggle(type)}
                    />
                    <label htmlFor={`preset-claim-${type}`} style={{ flex: 1 }}>
                      {meta.title}
                    </label>
                    {needsThreshold && selected[type] && (
                      <input
                        type="number"
                        placeholder="min threshold"
                        value={thresholds[type] ?? ""}
                        onChange={(e) =>
                          setThresholds((t) => ({ ...t, [type]: e.target.value }))
                        }
                        style={{ width: "9rem" }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <button
            className="btn btn-primary"
            style={{ marginTop: "1.25rem", width: "100%" }}
            disabled={!canSave}
            onClick={onSave}
          >
            Save preset
          </button>
        </div>

        <div className="card" style={{ minHeight: 200 }}>
          <span className="eyebrow" style={{ marginBottom: "0.75rem", display: "block" }}>
            Your presets ({presets.length})
          </span>
          {presets.length === 0 ? (
            <p className="faint" style={{ fontSize: "0.875rem" }}>
              No presets saved yet.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  style={{
                    padding: "0.75rem",
                    borderRadius: "var(--radius)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <div className="between">
                    <strong>{preset.name}</strong>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => onDelete(preset.id)}
                    >
                      Delete
                    </button>
                  </div>
                  <p
                    className="faint"
                    style={{ fontSize: "0.8125rem", margin: "0.35rem 0" }}
                  >
                    {preset.claims
                      .map((c) =>
                        c.minThreshold !== undefined
                          ? `${TYPE_META[c.type].title} (≥ ${c.minThreshold})`
                          : TYPE_META[c.type].title,
                      )
                      .join(", ")}
                  </p>
                  <div className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
                    <code
                      className="mono faint"
                      style={{
                        fontSize: "0.75rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                      }}
                    >
                      {shareUrl(preset)}
                    </code>
                    <CopyButton value={shareUrl(preset)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
