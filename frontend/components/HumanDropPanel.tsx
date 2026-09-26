"use client";

// HumanDrop — the worked airdrop example for the apps gallery.
//
// It demonstrates, interactively, what `human_airdrop` enforces on-chain:
// a campaign-scoped nullifier is derived from the *credential*, not the
// wallet, so one human gets exactly one claim per campaign no matter how many
// addresses they control.
//
// The panel is a faithful simulation: nullifiers are derived with the SDK's
// `deriveNullifier`, which is byte-for-byte the same sha256(commitment ||
// scope) the contract computes. Only the ledger write is local, so the demo
// works against any deployment (or none).

import { useEffect, useMemo, useState } from "react";
import {
  IconCheck,
  IconAlertTriangle,
  IconFingerprint,
  IconWallet,
  IconRefresh,
} from "@tabler/icons-react";
import { deriveNullifier } from "@stellarcred/sdk";
import { Badge } from "@/components/Badge";
import type { AirdropCampaign } from "@/lib/protocols";

/**
 * Demo identity commitments. `HUMAN_A` is the real commitment from the repo's
 * KYC proof fixture — the same value the contract tests assert on — so the
 * nullifier rendered here matches `contracts/human_airdrop/src/test.rs`.
 */
const HUMAN_A = "289538cac0e6b6b0e600b7d321883060ab0046854d95a0d1a501c11bc5d2499a";
const HUMAN_B = "7b1f0c94ad2e5583c6a4d1f80e93b27c5518aa0d6f34e2b19c8750d3a6e4f112";

interface DemoWallet {
  id: string;
  address: string;
  label: string;
  commitment: string;
  note: string;
}

const WALLETS: DemoWallet[] = [
  {
    id: "primary",
    address: "GA7Q…K42B",
    label: "Your wallet",
    commitment: HUMAN_A,
    note: "Holds a valid KYC credential.",
  },
  {
    id: "sybil",
    address: "GBX9…P0LM",
    label: "Second wallet, same human",
    commitment: HUMAN_A,
    note: "Same credential re-submitted from a fresh address.",
  },
  {
    id: "other",
    address: "GCD3…T7WQ",
    label: "A different human",
    commitment: HUMAN_B,
    note: "A separate credential, so a separate nullifier.",
  },
];

interface LogLine {
  ok: boolean;
  text: string;
}

export function HumanDropPanel({ campaign }: { campaign: AirdropCampaign }) {
  const [nullifiers, setNullifiers] = useState<Record<string, string>>({});
  const [spent, setSpent] = useState<string[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        WALLETS.map(async (w) => [w.id, await deriveNullifier(w.commitment, campaign.scope)] as const),
      );
      if (!cancelled) setNullifiers(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [campaign.scope]);

  const claimed = useMemo(() => new Set(spent), [spent]);

  function claim(wallet: DemoWallet) {
    const nullifier = nullifiers[wallet.id];
    if (!nullifier) return;
    if (claimed.has(nullifier)) {
      setLog((l) => [
        {
          ok: false,
          text: `claim(${wallet.address}, "${campaign.campaignId}") → Error #8 AlreadyClaimed — nullifier ${short(nullifier)} is already spent in this campaign.`,
        },
        ...l,
      ]);
      return;
    }
    setSpent((s) => [...s, nullifier]);
    setLog((l) => [
      {
        ok: true,
        text: `claim(${wallet.address}, "${campaign.campaignId}") → ${campaign.amountLabel} sent. Nullifier ${short(nullifier)} burned.`,
      },
      ...l,
    ]);
  }

  function reset() {
    setSpent([]);
    setLog([]);
  }

  return (
    <div className="card" style={{ marginTop: "1.5rem" }} data-testid="humandrop-panel">
      <div className="between" style={{ marginBottom: "1rem" }}>
        <span className="eyebrow">One claim per human — live demo</span>
        <Badge variant="verified">Nullifier-gated</Badge>
      </div>

      <p className="muted" style={{ fontSize: "0.875rem", lineHeight: 1.7 }}>
        The campaign scope{" "}
        <code className="mono" style={{ fontSize: "0.78rem" }}>
          {campaign.scope}
        </code>{" "}
        is hashed together with the credential&apos;s identity commitment to produce a
        campaign-scoped nullifier. Two wallets holding the <strong>same credential</strong> produce
        the <strong>same nullifier</strong> — so the second claim is rejected on-chain. Try it:
      </p>

      <div className="stack" style={{ marginTop: "1.1rem" }}>
        {WALLETS.map((wallet) => {
          const nullifier = nullifiers[wallet.id];
          const isSpent = nullifier ? claimed.has(nullifier) : false;
          return (
            <div
              key={wallet.id}
              style={{
                padding: "0.8rem 0.95rem",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "rgba(255,255,255,0.02)",
              }}
            >
              <div className="between" style={{ gap: "0.75rem", alignItems: "center" }}>
                <div>
                  <div className="row" style={{ gap: "0.45rem", alignItems: "center" }}>
                    <IconWallet size={15} stroke={1.7} />
                    <strong style={{ fontSize: "0.875rem" }}>{wallet.label}</strong>
                    <span className="mono faint" style={{ fontSize: "0.75rem" }}>
                      {wallet.address}
                    </span>
                  </div>
                  <div className="faint" style={{ fontSize: "0.78rem", marginTop: "0.2rem" }}>
                    {wallet.note}
                  </div>
                  <div
                    className="mono faint row"
                    style={{ fontSize: "0.72rem", marginTop: "0.35rem", gap: "0.35rem" }}
                  >
                    <IconFingerprint size={13} />
                    nullifier {nullifier ? short(nullifier) : "deriving…"}
                  </div>
                </div>
                <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
                  {isSpent && <Badge variant="denied">Nullifier spent</Badge>}
                  <button
                    type="button"
                    className={isSpent ? "btn btn-secondary btn-sm" : "btn btn-primary btn-sm"}
                    onClick={() => claim(wallet)}
                    disabled={!nullifier}
                  >
                    {`Claim ${campaign.amountLabel}`}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="between" style={{ marginTop: "1rem", alignItems: "center" }}>
        <span className="faint" style={{ fontSize: "0.78rem" }}>
          Unique humans paid: <strong>{spent.length}</strong> · Allocation {campaign.amountLabel}{" "}
          each
        </span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>
          <IconRefresh size={14} /> Reset campaign
        </button>
      </div>

      {log.length > 0 && (
        <div
          className="stack"
          style={{
            marginTop: "1rem",
            padding: "0.75rem 0.9rem",
            borderRadius: "var(--radius)",
            background: "rgba(0,0,0,0.25)",
            border: "1px solid var(--border)",
            gap: "0.4rem",
          }}
        >
          {log.map((line, i) => (
            <div
              key={`${line.text}-${i}`}
              className="mono row"
              style={{
                gap: "0.45rem",
                alignItems: "flex-start",
                fontSize: "0.75rem",
                color: line.ok ? "var(--text)" : "var(--danger)",
              }}
            >
              {line.ok ? (
                <IconCheck size={13} stroke={2.4} color="var(--accent)" />
              ) : (
                <IconAlertTriangle size={13} stroke={2.2} />
              )}
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      )}

      <p className="faint" style={{ marginTop: "1rem", fontSize: "0.78rem", lineHeight: 1.6 }}>
        On-chain this is{" "}
        <code className="mono">
          human_airdrop.claim(caller, &quot;{campaign.campaignId}&quot;)
        </code>
        , which reads{" "}
        <code className="mono">proof_registry.app_nullifier(...)</code> and refuses a nullifier it
        has already seen. See <code className="mono">docs/ANTI_SYBIL.md</code> for the guarantees
        and their limits.
      </p>
    </div>
  );
}

function short(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}
