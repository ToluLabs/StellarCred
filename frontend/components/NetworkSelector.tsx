"use client";

import { useState, useEffect } from "react";
import { IconWorld, IconAlertTriangle, IconChevronDown } from "@tabler/icons-react";
import { StellarNetwork, NETWORK_PRESETS } from "../lib/stellar";
import { getPreferredNetwork, setPreferredNetwork } from "../lib/network-storage";

export function NetworkSelector() {
  const [currentNetwork, setCurrentNetwork] = useState<StellarNetwork>("testnet");
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setCurrentNetwork(getPreferredNetwork());
  }, []);

  const handleSelect = (net: StellarNetwork) => {
    setPreferredNetwork(net);
    setCurrentNetwork(net);
    setIsOpen(false);
    window.location.reload();
  };

  const activePreset = NETWORK_PRESETS[currentNetwork];

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.5rem 0.8rem",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          cursor: "pointer",
          fontSize: "0.875rem",
        }}
        aria-expanded={isOpen}
        aria-label="Select Stellar Network"
      >
        <IconWorld size={16} />
        <span style={{ textTransform: "capitalize" }}>{currentNetwork}</span>
        {activePreset?.deprecated && (
          <IconAlertTriangle size={14} style={{ color: "var(--warn)" }} title="Deprecated network" />
        )}
        <IconChevronDown size={14} />
      </button>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            right: 0,
            marginTop: "0.25rem",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 100,
            minWidth: "200px",
          }}
        >
          {(Object.keys(NETWORK_PRESETS) as StellarNetwork[]).map((net) => {
            const preset = NETWORK_PRESETS[net];
            const isSelected = net === currentNetwork;
            return (
              <button
                key={net}
                onClick={() => handleSelect(net)}
                style={{
                  width: "100%",
                  padding: "0.75rem 1rem",
                  textAlign: "left",
                  background: isSelected ? "var(--primary-subtle)" : "transparent",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                  color: "var(--text)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.25rem",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: isSelected ? 600 : 400, textTransform: "capitalize" }}>
                    {net}
                  </span>
                  {preset.deprecated && (
                    <span style={{ fontSize: "0.7rem", color: "var(--warn)", background: "rgba(227, 179, 65, 0.1)", padding: "0.1rem 0.3rem", borderRadius: "4px" }}>
                      Deprecated
                    </span>
                  )}
                  {preset.unavailable && (
                    <span style={{ fontSize: "0.7rem", color: "var(--danger)", background: "rgba(240, 96, 77, 0.1)", padding: "0.1rem 0.3rem", borderRadius: "4px" }}>
                      Unavailable
                    </span>
                  )}
                </div>
                {preset.warningMessage && (
                  <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                    {preset.warningMessage}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {activePreset?.warningMessage && (
        <div
          role="alert"
          style={{
            marginTop: "0.5rem",
            padding: "0.5rem",
            fontSize: "0.75rem",
            color: "var(--warn)",
            background: "rgba(227, 179, 65, 0.08)",
            borderRadius: "var(--radius)",
            border: "1px solid rgba(227, 179, 65, 0.2)",
          }}
        >
          {activePreset.warningMessage}
        </div>
      )}
    </div>
  );
}
