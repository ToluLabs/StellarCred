"use client";

import { useState, useRef } from "react";
import {
  IconShieldLock,
  IconKey,
  IconDownload,
  IconPlus,
  IconCheck,
  IconTrash,
  IconQrcode,
  IconUpload,
} from "@tabler/icons-react";
import { QrCodeModal } from "../QrCodeModal";
import CopyButton from "../CopyButton";
import { Badge } from "../Badge";
import type { Credential } from "@/lib/credential";
import { loadCredentials, saveCredential } from "@/lib/credential";
import {
  createGuardianRecoverySetup,
  recoverCredentialsFromShares,
  parseGuardianShare,
  parseGuardianBackup,
  formatShareArmored,
  downloadGuardianBackup,
  downloadGuardianShare,
  downloadRecoveryKit,
  type GuardianShare,
  type GuardianEncryptedBackup,
  type GuardianRecoveryKit,
  GuardianRecoveryError,
} from "@/lib/guardian";
import { truncateHash } from "@/lib/format";

interface GuardianRecoveryModalProps {
  initialTab?: "setup" | "recover";
  onClose: () => void;
  onRestored?: (credentials: Credential[]) => void;
}

export function GuardianRecoveryModal({
  initialTab = "setup",
  onClose,
  onRestored,
}: GuardianRecoveryModalProps) {
  const [activeTab, setActiveTab] = useState<"setup" | "recover">(initialTab);

  // Setup tab state
  const [totalShares, setTotalShares] = useState(3);
  const [threshold, setThreshold] = useState(2);
  const [guardianLabels, setGuardianLabels] = useState<string[]>([
    "Alice (Family)",
    "Bob (Friend)",
    "Backup Hardware/Device",
  ]);
  const [setupResult, setSetupResult] = useState<{
    backup: GuardianEncryptedBackup;
    shares: GuardianShare[];
    recoveryKit: GuardianRecoveryKit;
  } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [activeQrShare, setActiveQrShare] = useState<GuardianShare | null>(null);

  // Recovery tab state
  const [backupPayload, setBackupPayload] = useState("");
  const [parsedBackup, setParsedBackup] = useState<GuardianEncryptedBackup | null>(null);
  const [shareInputText, setShareInputText] = useState("");
  const [collectedShares, setCollectedShares] = useState<GuardianShare[]>([]);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoverySuccess, setRecoverySuccess] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [recoveredCreds, setRecoveredCreds] = useState<Credential[] | null>(null);
  const [restoreMode, setRestoreMode] = useState<"merge" | "replace">("merge");

  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const shareFileInputRef = useRef<HTMLInputElement>(null);

  // Update guardian labels array length when totalShares changes
  const handleTotalSharesChange = (n: number) => {
    setTotalShares(n);
    if (threshold > n) setThreshold(n);
    const updated = [...guardianLabels];
    while (updated.length < n) {
      updated.push(`Guardian ${updated.length + 1}`);
    }
    setGuardianLabels(updated.slice(0, n));
  };

  const handleGenerateSetup = async () => {
    setIsGenerating(true);
    setSetupError("");
    try {
      const credentials = await loadCredentials();
      const result = await createGuardianRecoverySetup(credentials, {
        totalShares,
        threshold,
        guardianLabels,
      });
      setSetupResult(result);
    } catch (err) {
      setSetupError(
        err instanceof Error ? err.message : "Failed to generate guardian recovery setup",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleBackupFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setBackupPayload(text);
      handleParseBackupText(text);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleParseBackupText = (text: string) => {
    setRecoveryError("");
    setRecoveredCreds(null);
    try {
      const parsed = parseGuardianBackup(text);
      setParsedBackup(parsed);
    } catch (err) {
      setParsedBackup(null);
      setRecoveryError(
        err instanceof Error ? err.message : "Invalid guardian backup JSON or recovery kit",
      );
    }
  };

  const handleShareFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      addShareFromText(text);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const addShareFromText = (rawText: string) => {
    setRecoveryError("");
    try {
      const share = parseGuardianShare(rawText);
      if (parsedBackup && share.recoveryId !== parsedBackup.recoveryId) {
        throw new GuardianRecoveryError(
          `Share belongs to recovery ID "${share.recoveryId}", but active backup requires "${parsedBackup.recoveryId}"`,
        );
      }
      if (collectedShares.some((s) => s.guardianIndex === share.guardianIndex)) {
        throw new GuardianRecoveryError(
          `Share for Guardian #${share.guardianIndex} is already added.`,
        );
      }
      setCollectedShares([...collectedShares, share]);
      setShareInputText("");
    } catch (err) {
      setRecoveryError(
        err instanceof Error ? err.message : "Invalid guardian share format",
      );
    }
  };

  const handleRemoveShare = (guardianIndex: number) => {
    setCollectedShares(collectedShares.filter((s) => s.guardianIndex !== guardianIndex));
    setRecoveredCreds(null);
  };

  const handleDecrypt = async () => {
    if (!parsedBackup) return;
    setIsDecrypting(true);
    setRecoveryError("");
    try {
      const creds = await recoverCredentialsFromShares(parsedBackup, collectedShares);
      setRecoveredCreds(creds);
    } catch (err) {
      setRecoveryError(
        err instanceof Error ? err.message : "Decryption failed: invalid or mismatched shares",
      );
    } finally {
      setIsDecrypting(false);
    }
  };

  const handleApplyRestore = () => {
    if (!recoveredCreds) return;
    if (restoreMode === "replace") {
      try {
        localStorage.setItem("stellarcred:credentials", JSON.stringify(recoveredCreds));
      } catch {}
    } else {
      for (const cred of recoveredCreds) {
        saveCredential(cred);
      }
    }
    setRecoverySuccess(true);
    onRestored?.(recoveredCreds);
  };

  if (activeQrShare) {
    const armored = formatShareArmored(activeQrShare);
    return (
      <QrCodeModal
        title={`Guardian Share #${activeQrShare.guardianIndex}${activeQrShare.guardianLabel ? ` (${activeQrShare.guardianLabel})` : ""}`}
        value={armored}
        hint="Scan this code on the guardian's device or have them copy the code below. This share alone reveals nothing about your credentials."
        onClose={() => setActiveQrShare(null)}
      />
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.65)",
          backdropFilter: "blur(6px)",
        }}
        onClick={onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Guardian Secret Sharing Recovery"
        className="card"
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 620,
          maxHeight: "90vh",
          overflowY: "auto",
          padding: "1.5rem",
        }}
      >
        <div className="between" style={{ alignItems: "center", marginBottom: "1.25rem" }}>
          <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "var(--radius-sm)",
                background: "var(--accent-soft)",
                color: "var(--accent)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <IconShieldLock size={18} />
            </div>
            <div>
              <h2 style={{ fontSize: "1.15rem", fontWeight: 600 }}>Guardian Secret Sharing</h2>
              <p className="faint" style={{ fontSize: "0.75rem" }}>
                Client-side threshold key recovery
              </p>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} style={{ padding: "0.3rem" }}>
            ✕
          </button>
        </div>

        {/* Tab switcher */}
        <div
          className="row"
          style={{
            background: "rgba(255, 255, 255, 0.04)",
            padding: "0.25rem",
            borderRadius: "var(--radius-sm)",
            marginBottom: "1.25rem",
            gap: "0.25rem",
          }}
        >
          <button
            className={`btn btn-sm ${activeTab === "setup" ? "btn-secondary" : "btn-ghost"}`}
            style={{
              flex: 1,
              background: activeTab === "setup" ? "var(--card-hover)" : "transparent",
              fontWeight: activeTab === "setup" ? 600 : 400,
            }}
            onClick={() => setActiveTab("setup")}
          >
            <IconShieldLock size={14} />
            Set Up Guardians
          </button>
          <button
            className={`btn btn-sm ${activeTab === "recover" ? "btn-secondary" : "btn-ghost"}`}
            style={{
              flex: 1,
              background: activeTab === "recover" ? "var(--card-hover)" : "transparent",
              fontWeight: activeTab === "recover" ? 600 : 400,
            }}
            onClick={() => setActiveTab("recover")}
          >
            <IconKey size={14} />
            Recover Credentials
          </button>
        </div>

        {/* TAB 1: SETUP GUARDIANS */}
        {activeTab === "setup" && (
          <div>
            {!setupResult ? (
              <div className="stack" style={{ gap: "1rem" }}>
                <p className="faint" style={{ fontSize: "0.8125rem", lineHeight: 1.6 }}>
                  Split your credential encryption key among trusted guardians (family, friends, or
                  backup devices) using Shamir Secret Sharing. Any threshold of shares can restore
                  your credentials if browser storage is wiped. Guardians never see credential data,
                  only key shares.
                </p>

                <div
                  style={{
                    background: "rgba(255, 255, 255, 0.02)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "1rem",
                  }}
                >
                  <div className="row" style={{ gap: "1.5rem", flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 140 }}>
                      <label className="field-label">Total Guardians (N)</label>
                      <select
                        value={totalShares}
                        onChange={(e) => handleTotalSharesChange(parseInt(e.target.value, 10))}
                        style={{
                          width: "100%",
                          padding: "0.5rem 0.75rem",
                          borderRadius: "var(--radius-xs)",
                          background: "var(--input)",
                          border: "1px solid var(--border)",
                          color: "var(--text)",
                        }}
                      >
                        {[2, 3, 4, 5, 6, 7].map((n) => (
                          <option key={n} value={n}>
                            {n} Guardians
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ flex: 1, minWidth: 140 }}>
                      <label className="field-label">Required Threshold (K)</label>
                      <select
                        value={threshold}
                        onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
                        style={{
                          width: "100%",
                          padding: "0.5rem 0.75rem",
                          borderRadius: "var(--radius-xs)",
                          background: "var(--input)",
                          border: "1px solid var(--border)",
                          color: "var(--text)",
                        }}
                      >
                        {Array.from({ length: totalShares - 1 }, (_, i) => i + 2).map((k) => (
                          <option key={k} value={k}>
                            {k} of {totalShares} shares
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ marginTop: "1rem" }}>
                    <label className="field-label">Guardian Labels</label>
                    <div className="stack" style={{ gap: "0.5rem" }}>
                      {Array.from({ length: totalShares }).map((_, i) => (
                        <div key={i} className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
                          <span
                            className="mono faint"
                            style={{ fontSize: "0.75rem", width: 80, flexShrink: 0 }}
                          >
                            Guardian {i + 1}:
                          </span>
                          <input
                            type="text"
                            value={guardianLabels[i] || ""}
                            placeholder={`e.g. ${i === 0 ? "Alice (Sister)" : i === 1 ? "Bob (Friend)" : "Safe/Device"}`}
                            onChange={(e) => {
                              const next = [...guardianLabels];
                              next[i] = e.target.value;
                              setGuardianLabels(next);
                            }}
                            style={{ flex: 1, padding: "0.4rem 0.6rem", fontSize: "0.8125rem" }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {setupError && (
                  <p style={{ color: "var(--danger)", fontSize: "0.8125rem" }}>{setupError}</p>
                )}

                <button
                  className="btn btn-primary"
                  onClick={handleGenerateSetup}
                  disabled={isGenerating}
                  style={{ width: "100%", marginTop: "0.5rem" }}
                >
                  {isGenerating ? "Generating Recovery Shares…" : "Generate Guardian Shares"}
                </button>
              </div>
            ) : (
              /* Setup generated view */
              <div className="stack" style={{ gap: "1.25rem" }}>
                <div
                  style={{
                    border: "1px solid var(--accent-soft)",
                    background: "rgba(62, 207, 142, 0.05)",
                    borderRadius: "var(--radius-sm)",
                    padding: "0.85rem 1rem",
                  }}
                >
                  <div className="between" style={{ alignItems: "center" }}>
                    <div>
                      <span style={{ fontWeight: 600, color: "var(--accent)", fontSize: "0.875rem" }}>
                        Recovery Setup Generated
                      </span>
                      <div className="mono faint" style={{ fontSize: "0.75rem", marginTop: "0.2rem" }}>
                        Recovery ID: {setupResult.backup.recoveryId} · Threshold:{" "}
                        {setupResult.backup.threshold} of {setupResult.backup.totalShares}
                      </div>
                    </div>
                    <Badge variant="verified" dot={false}>
                      {setupResult.backup.credentialCount} credentials
                    </Badge>
                  </div>
                </div>

                {/* Step 1: Encrypted Backup */}
                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "1rem",
                  }}
                >
                  <div className="between" style={{ alignItems: "center", marginBottom: "0.5rem" }}>
                    <div>
                      <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                        1. Encrypted Backup File
                      </span>
                      <p className="faint" style={{ fontSize: "0.75rem" }}>
                        Save this file to your personal drive. Needed during recovery.
                      </p>
                    </div>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => downloadGuardianBackup(setupResult.backup)}
                    >
                      <IconDownload size={14} />
                      Download Backup (.json)
                    </button>
                  </div>
                </div>

                {/* Step 2: Guardian Shares */}
                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "1rem",
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                    2. Distribute Guardian Shares
                  </span>
                  <p className="faint" style={{ fontSize: "0.75rem", marginBottom: "0.75rem" }}>
                    Send each share to the respective guardian. Key shares contain NO credential data.
                  </p>

                  <div className="stack" style={{ gap: "0.5rem" }}>
                    {setupResult.shares.map((share) => (
                      <div
                        key={share.guardianIndex}
                        className="card"
                        style={{
                          padding: "0.6rem 0.8rem",
                          background: "rgba(255, 255, 255, 0.02)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        <div className="between" style={{ alignItems: "center" }}>
                          <div>
                            <span style={{ fontWeight: 600, fontSize: "0.8125rem" }}>
                              Share #{share.guardianIndex}
                              {share.guardianLabel ? `: ${share.guardianLabel}` : ""}
                            </span>
                            <div className="mono faint" style={{ fontSize: "0.7rem" }}>
                              Fingerprint: {share.keyFingerprint.slice(0, 8)}…
                            </div>
                          </div>
                          <div className="row" style={{ gap: "0.4rem" }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              title="Download individual share JSON"
                              onClick={() => downloadGuardianShare(share)}
                              style={{ padding: "0.3rem 0.5rem" }}
                            >
                              <IconDownload size={13} />
                            </button>
                            <CopyButton
                              value={formatShareArmored(share)}
                            />
                            <button
                              className="btn btn-ghost btn-sm"
                              title="View QR Code"
                              onClick={() => setActiveQrShare(share)}
                              style={{ padding: "0.3rem 0.5rem" }}
                            >
                              <IconQrcode size={13} />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Step 3: Master Recovery Kit */}
                <div className="between" style={{ alignItems: "center" }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => downloadRecoveryKit(setupResult.recoveryKit)}
                  >
                    <IconDownload size={14} />
                    Download Complete Recovery Kit
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={onClose}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: RECOVER CREDENTIALS */}
        {activeTab === "recover" && (
          <div>
            {recoverySuccess ? (
              <div style={{ textAlign: "center", padding: "1.5rem 0" }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: "50%",
                    background: "var(--accent-soft)",
                    color: "var(--accent)",
                    display: "grid",
                    placeItems: "center",
                    margin: "0 auto 1rem",
                  }}
                >
                  <IconCheck size={28} />
                </div>
                <h3 style={{ fontSize: "1.1rem", marginBottom: "0.4rem" }}>
                  Credentials Restored Successfully!
                </h3>
                <p className="faint" style={{ fontSize: "0.8125rem", marginBottom: "1.25rem" }}>
                  Your recovered credentials have been safely restored to this browser&rsquo;s local
                  storage.
                </p>
                <button className="btn btn-primary" onClick={onClose} style={{ width: "100%" }}>
                  Return to Holder Dashboard
                </button>
              </div>
            ) : !recoveredCreds ? (
              <div className="stack" style={{ gap: "1.25rem" }}>
                {/* Step 1: Upload Backup */}
                <div>
                  <div className="between" style={{ alignItems: "center", marginBottom: "0.4rem" }}>
                    <label className="field-label" style={{ margin: 0 }}>
                      Step 1: Provide Encrypted Backup
                    </label>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => backupFileInputRef.current?.click()}
                      style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                    >
                      <IconUpload size={12} />
                      Upload Backup File
                    </button>
                    <input
                      ref={backupFileInputRef}
                      type="file"
                      accept=".json"
                      onChange={handleBackupFileUpload}
                      style={{ display: "none" }}
                    />
                  </div>

                  <textarea
                    rows={parsedBackup ? 2 : 3}
                    placeholder="Paste backup JSON or full recovery kit JSON here…"
                    value={backupPayload}
                    onChange={(e) => {
                      setBackupPayload(e.target.value);
                      if (e.target.value.trim()) {
                        handleParseBackupText(e.target.value);
                      } else {
                        setParsedBackup(null);
                      }
                    }}
                    style={{
                      width: "100%",
                      fontSize: "0.75rem",
                      fontFamily: "var(--font-mono), monospace",
                      padding: "0.5rem",
                      background: "var(--input)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-xs)",
                      color: "var(--text)",
                    }}
                  />

                  {parsedBackup && (
                    <div
                      style={{
                        marginTop: "0.5rem",
                        padding: "0.6rem 0.8rem",
                        background: "rgba(255, 255, 255, 0.03)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-xs)",
                        fontSize: "0.75rem",
                      }}
                    >
                      <div className="between" style={{ alignItems: "center" }}>
                        <span className="mono">
                          Recovery ID: <strong>{parsedBackup.recoveryId}</strong>
                        </span>
                        <Badge variant="pending" dot={false}>
                          Requires {parsedBackup.threshold} of {parsedBackup.totalShares} shares
                        </Badge>
                      </div>
                      {parsedBackup.guardianLabels && parsedBackup.guardianLabels.length > 0 && (
                        <div className="faint" style={{ marginTop: "0.25rem", fontSize: "0.7rem" }}>
                          Expected Guardians: {parsedBackup.guardianLabels.join(", ")}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Step 2: Collect Guardian Shares */}
                <div>
                  <div className="between" style={{ alignItems: "center", marginBottom: "0.4rem" }}>
                    <label className="field-label" style={{ margin: 0 }}>
                      Step 2: Enter Guardian Shares
                    </label>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => shareFileInputRef.current?.click()}
                      style={{ fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                    >
                      <IconUpload size={12} />
                      Upload Share File
                    </button>
                    <input
                      ref={shareFileInputRef}
                      type="file"
                      accept=".json"
                      onChange={handleShareFileUpload}
                      style={{ display: "none" }}
                    />
                  </div>

                  <div className="row" style={{ gap: "0.5rem", marginBottom: "0.75rem" }}>
                    <input
                      type="text"
                      placeholder="Paste guardian share JSON or SC-SHARE code…"
                      value={shareInputText}
                      onChange={(e) => setShareInputText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && shareInputText.trim()) {
                          addShareFromText(shareInputText);
                        }
                      }}
                      style={{ flex: 1, padding: "0.4rem 0.6rem", fontSize: "0.8125rem" }}
                    />
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={!shareInputText.trim()}
                      onClick={() => addShareFromText(shareInputText)}
                    >
                      <IconPlus size={14} />
                      Add Share
                    </button>
                  </div>

                  {/* Shares collection status */}
                  <div
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      padding: "0.75rem",
                      background: "rgba(255, 255, 255, 0.01)",
                    }}
                  >
                    <div className="between" style={{ alignItems: "center", marginBottom: "0.5rem" }}>
                      <span style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                        Collected Shares: {collectedShares.length}
                        {parsedBackup ? ` / ${parsedBackup.threshold} required` : ""}
                      </span>
                      {parsedBackup && collectedShares.length >= parsedBackup.threshold ? (
                        <Badge variant="verified" dot={true}>
                          Threshold Met
                        </Badge>
                      ) : (
                        <Badge variant="pending" dot={false}>
                          Waiting for shares
                        </Badge>
                      )}
                    </div>

                    {collectedShares.length === 0 ? (
                      <p className="faint" style={{ fontSize: "0.75rem", textAlign: "center", padding: "0.5rem 0" }}>
                        No guardian shares added yet. Paste a share code or upload a share file above.
                      </p>
                    ) : (
                      <div className="stack" style={{ gap: "0.4rem" }}>
                        {collectedShares.map((s) => (
                          <div
                            key={s.guardianIndex}
                            className="card"
                            style={{
                              padding: "0.4rem 0.6rem",
                              background: "rgba(255, 255, 255, 0.02)",
                              border: "1px solid var(--border)",
                            }}
                          >
                            <div className="between" style={{ alignItems: "center" }}>
                              <div className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
                                <IconCheck size={14} color="var(--accent)" />
                                <span style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                                  Guardian #{s.guardianIndex}
                                  {s.guardianLabel ? ` (${s.guardianLabel})` : ""}
                                </span>
                              </div>
                              <button
                                className="btn btn-ghost btn-sm"
                                onClick={() => handleRemoveShare(s.guardianIndex)}
                                style={{ padding: "0.2rem 0.4rem", color: "var(--danger)" }}
                              >
                                <IconTrash size={13} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {recoveryError && (
                  <div
                    style={{
                      border: "1px solid rgba(240, 96, 77, 0.3)",
                      background: "rgba(240, 96, 77, 0.08)",
                      borderRadius: "var(--radius-xs)",
                      padding: "0.6rem 0.8rem",
                      color: "var(--danger)",
                      fontSize: "0.8125rem",
                    }}
                  >
                    {recoveryError}
                  </div>
                )}

                <button
                  className="btn btn-primary"
                  onClick={handleDecrypt}
                  disabled={
                    isDecrypting ||
                    !parsedBackup ||
                    collectedShares.length < parsedBackup.threshold
                  }
                  style={{ width: "100%" }}
                >
                  {isDecrypting ? "Reconstructing Key & Decrypting…" : "Decrypt Credentials"}
                </button>
              </div>
            ) : (
              /* Decrypted Preview and Confirm */
              <div className="stack" style={{ gap: "1rem" }}>
                <div
                  style={{
                    border: "1px solid var(--accent-soft)",
                    background: "rgba(62, 207, 142, 0.05)",
                    borderRadius: "var(--radius-sm)",
                    padding: "0.8rem 1rem",
                  }}
                >
                  <span style={{ fontWeight: 600, color: "var(--accent)", fontSize: "0.875rem" }}>
                    Successfully Decrypted {recoveredCreds.length} Credentials
                  </span>
                  <p className="faint" style={{ fontSize: "0.75rem", marginTop: "0.2rem" }}>
                    The encryption key was verified and restored from your guardian shares.
                  </p>
                </div>

                {/* List of recovered credentials */}
                <div className="stack" style={{ gap: "0.5rem", maxHeight: 200, overflowY: "auto" }}>
                  {recoveredCreds.map((c, i) => (
                    <div
                      key={c.commitment || i}
                      className="card"
                      style={{
                        padding: "0.6rem 0.8rem",
                        background: "rgba(255, 255, 255, 0.02)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <div className="between" style={{ alignItems: "center" }}>
                        <div>
                          <div className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
                            <span style={{ fontWeight: 600, fontSize: "0.8125rem" }}>{c.title}</span>
                            <span className="mono faint" style={{ fontSize: "0.7rem" }}>
                              {c.claim}
                            </span>
                          </div>
                          <div className="mono faint" style={{ fontSize: "0.7rem", marginTop: "0.1rem" }}>
                            {c.issuer} · {truncateHash(c.commitment)}
                          </div>
                        </div>
                        <Badge variant="verified" dot={false}>
                          Valid
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Restore Mode Options */}
                <div style={{ fontSize: "0.8125rem" }}>
                  <label className="field-label" style={{ marginBottom: "0.4rem" }}>
                    Restore Action
                  </label>
                  <div className="stack" style={{ gap: "0.4rem" }}>
                    <label className="row" style={{ gap: "0.5rem", alignItems: "center", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="restoreMode"
                        checked={restoreMode === "merge"}
                        onChange={() => setRestoreMode("merge")}
                      />
                      <span>Merge with existing local credentials (recommended)</span>
                    </label>
                    <label className="row" style={{ gap: "0.5rem", alignItems: "center", cursor: "pointer" }}>
                      <input
                        type="radio"
                        name="restoreMode"
                        checked={restoreMode === "replace"}
                        onChange={() => setRestoreMode("replace")}
                      />
                      <span>Replace all existing credentials in this browser</span>
                    </label>
                  </div>
                </div>

                <div className="row" style={{ gap: "0.75rem", marginTop: "0.5rem" }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setRecoveredCreds(null)}
                    style={{ flex: 1 }}
                  >
                    Back
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={handleApplyRestore}
                    style={{ flex: 2 }}
                  >
                    Restore to Wallet
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
export default GuardianRecoveryModal;
