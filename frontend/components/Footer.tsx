"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

interface ContractVersion {
  address: string;
  version: string;
  status: "ok" | "error";
  message?: string;
}

interface VersionInfo {
  app_version?: string;
  contract_versions?: Record<string, ContractVersion>;
  loading?: boolean;
}

export function Footer() {
  const t = useTranslations();
  const [versionInfo, setVersionInfo] = useState<VersionInfo>({
    loading: true,
  });
  const [showVersions, setShowVersions] = useState(false);

  useEffect(() => {
    const fetchVersions = async () => {
      try {
        const res = await fetch("/api/ready");
        if (res.ok) {
          const data = await res.json();
          setVersionInfo({
            app_version: data.app_version,
            contract_versions: data.contract_versions,
            loading: false,
          });
        } else {
          setVersionInfo({ loading: false });
        }
      } catch {
        setVersionInfo({ loading: false });
      }
    };

    fetchVersions();
  }, []);

  const sdkVersion = "0.1.1"; // From frontend/packages/sdk/package.json

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <span className="faint" style={{ fontSize: "0.8125rem" }}>
          {t("footer.copyright", { year: new Date().getFullYear() })}
        </span>
        <div className="row" style={{ gap: "1.5rem" }}>
          <a
            href="https://github.com/Psalmuel01/StellarCred"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-link"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-label="GitHub"
            >
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            GitHub
          </a>
          <a
            href="https://github.com/Psalmuel01/StellarCred/tree/main/frontend/packages/sdk"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-link mono"
            style={{ fontSize: "0.75rem" }}
          >
            @stellarcred/sdk
          </a>
          <a href="/developers" className="footer-link">
            {t("footer.docs")}
            Docs
          </a>

          {/* Version Info Toggle */}
          <button
            onClick={() => setShowVersions(!showVersions)}
            className="footer-link"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
              font: "inherit",
              color: "inherit",
              textDecoration: "none",
            }}
            title={t("footer.versionInfo")}
          >
            <span className="mono" style={{ fontSize: "0.75rem" }}>
              {versionInfo.app_version || t("footer.app")}
            </span>
          </button>
        </div>

        {/* Version Details Drawer */}
        {showVersions && (
          <div
            style={{
              marginTop: "1rem",
              padding: "1rem",
              backgroundColor: "var(--color-bg-secondary, #f5f5f5)",
              borderRadius: "0.375rem",
              fontSize: "0.75rem",
            }}
          >
            <div style={{ marginBottom: "0.5rem", fontWeight: 500 }}>
              {t("footer.deploymentVersions")}
            </div>

            {/* App Version */}
            <div style={{ marginBottom: "0.5rem" }}>
              <span className="faint">{t("footer.app")}:</span>{" "}
              <span className="mono">{versionInfo.app_version || t("footer.unknown")}</span>
            </div>

            {/* SDK Version */}
            <div style={{ marginBottom: "0.5rem" }}>
              <span className="faint">{t("footer.sdk_label")}:</span>{" "}
              <span className="mono">{sdkVersion}</span>
            </div>

            {/* Contract Versions */}
            {versionInfo.contract_versions &&
              Object.entries(versionInfo.contract_versions).map(
                ([name, cv]) => (
                  <div key={name} style={{ marginBottom: "0.5rem" }}>
                    <span className="faint">{name}:</span>{" "}
                    <span
                      className="mono"
                      style={{
                        color:
                          cv.status === "ok"
                            ? "var(--color-text-primary)"
                            : "var(--color-error, #e74c3c)",
                      }}
                    >
                      {cv.version || t("footer.unknown")}
                      {cv.status === "error" && ` (${cv.message})`}
                    </span>
                  </div>
                )
              )}

            {versionInfo.loading && (
              <div style={{ marginBottom: "0.5rem" }}>
                <span className="faint">Loading versions...</span>
              </div>
            )}

            <div style={{ marginTop: "0.75rem", fontSize: "0.7rem" }}>
              <button
                onClick={() => setShowVersions(false)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  font: "inherit",
                  color: "var(--color-primary, #007bff)",
                  textDecoration: "underline",
                }}
              >
                {t("common.close")}
              </button>
            </div>
          </div>
        )}
      </div>
    </footer>
  );
}
