/**
 * POST /api/sponsor — Gasless/sponsored proof submission relay.
 *
 * The holder POSTs their signed transaction XDR. The relay wraps it in a
 * fee-bump transaction signed by the sponsor account and submits it to the
 * network. The holder authorises the proof; the sponsor only pays the fee.
 *
 * Abuse protection:
 *   - Per-IP rate limiting (RATE_LIMIT_SPONSOR_IP, default 5/min)
 *   - Per-wallet rate limiting (RATE_LIMIT_SPONSOR_WALLET, default 3/min)
 *   - Sponsor secret is server-only (never prefixed NEXT_PUBLIC_)
 *   - Body size capped at 128 KB (signed XDR can be large for batches)
 *   - XDR is validated before the sponsor key is loaded
 */

import { NextRequest, NextResponse } from "next/server";
import {
  checkLimit,
  extractIp,
  LIMITS,
  tooManyRequestsResponse,
} from "@/lib/rate-limit";

// Read the sponsor secret once at module load.
const SPONSOR_SECRET = process.env.SPONSOR_SECRET ?? "";
const SPONSOR_ACCOUNT_ID = process.env.NEXT_PUBLIC_SPONSOR_ACCOUNT_ID ?? "";

// Body size limit — signed XDR for batch proofs can be larger than the
// standard 64 KB API limit.
const MAX_BODY_BYTES = 128 * 1024;

function sponsorConfigured(): boolean {
  return Boolean(SPONSOR_SECRET && SPONSOR_ACCOUNT_ID);
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function POST(req: NextRequest) {
  // ── Pre-flight: config check ───────────────────────────────────────────────
  if (!sponsorConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Sponsor relay not configured on this deployment." },
      { status: 503 },
    );
  }

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const ip = extractIp(req);
  const windowMs = LIMITS.windowMs();

  const ipLimit = readInt("RATE_LIMIT_SPONSOR_IP", 5);
  const walletLimit = readInt("RATE_LIMIT_SPONSOR_WALLET", 3);

  const ipCheck = checkLimit(`sponsor:ip:${ip}`, ipLimit, windowMs);
  if (ipCheck.throttled) {
    return tooManyRequestsResponse(ipCheck.retryAfterMs);
  }

  // ── Body parsing ───────────────────────────────────────────────────────────
  // Read the body manually to enforce the 128 KB cap (larger than the standard
  // MAX_BODY_BYTES because batch XDRs can be sizeable).
  let body: { signedXdr?: string; holder?: string };
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { ok: false, error: "Request body too large." },
        { status: 413 },
      );
    }
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const { signedXdr, holder } = body;
  if (!signedXdr || !holder) {
    return NextResponse.json(
      { ok: false, error: "Missing signedXdr or holder." },
      { status: 400 },
    );
  }

  // Per-wallet rate limit (using the holder address the client provided).
  const walletCheck = checkLimit(`sponsor:wallet:${holder}`, walletLimit, windowMs);
  if (walletCheck.throttled) {
    return tooManyRequestsResponse(walletCheck.retryAfterMs);
  }

  // ── Build fee-bump and submit ──────────────────────────────────────────────
  try {
    const sdk = await import("@stellar/stellar-sdk");
    const { TransactionBuilder, Keypair, BASE_FEE } = sdk;

    // Parse and decode the inner transaction from the holder's signed XDR.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerTx: any = TransactionBuilder.fromXDR(
      signedXdr,
      process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    );

    // Load the sponsor account to get the current sequence number.
    const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "https://soroban-testnet.stellar.org";
    const allowHttp = rpcUrl.startsWith("http://");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server: any = new sdk.rpc.Server(rpcUrl, { allowHttp });
    const sponsorKeypair = Keypair.fromSecret(SPONSOR_SECRET);

    // Wrap in a fee-bump: the outer transaction pays the fee, the inner
    // transaction carries the holder's authorisation.
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      sponsorKeypair,
      BASE_FEE,
      innerTx,
      process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    );
    feeBumpTx.sign(sponsorKeypair);

    // Submit the fee-bump transaction.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await server.sendTransaction(feeBumpTx as any);

    if (sent.status === "ERROR") {
      const errHex =
        sent.errorResult &&
        typeof (sent.errorResult as { toXDR?: (f: string) => string }).toXDR === "function"
          ? (sent.errorResult as { toXDR: (f: string) => string }).toXDR("hex")
          : String(sent.errorResult);
      return NextResponse.json(
        { ok: false, error: `Transaction rejected: ${errHex}` },
        { status: 422 },
      );
    }

    // Poll for confirmation (same pattern as contracts.ts).
    const isBadUnionSwitch = (e: unknown): boolean =>
      e instanceof Error && e.message.startsWith("Bad union switch");

    const start = Date.now();
    let result;
    try {
      result = await server.getTransaction(sent.hash);
    } catch (e) {
      if (isBadUnionSwitch(e)) {
        return NextResponse.json({ ok: true, txHash: sent.hash });
      }
      throw e;
    }
    while (result.status === "NOT_FOUND" && Date.now() - start < 65_000) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        result = await server.getTransaction(sent.hash);
      } catch (e) {
        if (isBadUnionSwitch(e)) {
          return NextResponse.json({ ok: true, txHash: sent.hash });
        }
        throw e;
      }
    }

    if (result.status !== "SUCCESS") {
      return NextResponse.json(
        { ok: false, error: `Transaction did not succeed (${result.status}).` },
        { status: 422 },
      );
    }

    return NextResponse.json({ ok: true, txHash: sent.hash });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { ok: false, error: `Sponsor relay error: ${message}` },
      { status: 500 },
    );
  }
}
