type PreviewWalletBannerProps = {
  onConnect: () => void;
};

export function PreviewWalletBanner({ onConnect }: PreviewWalletBannerProps) {
  return (
    <div
      style={{
        padding: "0.85rem 1rem",
        borderRadius: "var(--radius)",
        background: "rgba(62,207,142,0.1)",
        border: "1px solid rgba(62,207,142,0.3)",
        color: "var(--text)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "1.5rem",
      }}
    >
      <span style={{ fontSize: "0.875rem", fontWeight: 500 }}>
        Connect wallet to use your real credentials
      </span>
      <button className="btn btn-primary btn-sm" onClick={onConnect}>
        Connect Wallet
      </button>
    </div>
  );
}
