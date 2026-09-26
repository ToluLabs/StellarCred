import { describe, it, expect, vi } from "vitest";

import {
  createHumanClaim,
  deriveNullifier,
  decodeEligibility,
  decodeCampaign,
  scopeBytes,
  toHex,
  ELIGIBILITY_REASONS,
  type ContractArg,
  type ContractReader,
} from "./airdrop";

// Shared test vector, asserted identically by the contract test
// `contracts/human_airdrop/src/test.rs`. If either side of the derivation
// changes, one of the two suites goes red.
const COMMITMENT = "289538cac0e6b6b0e600b7d321883060ab0046854d95a0d1a501c11bc5d2499a";
const SCOPE = "stellarcred:airdrop:humandrop-2026";
const NULLIFIER = "ac90ac63aaa97462b9e71a746867b9593537198d8a140609ad42fd1c9c93a091";
const OTHER_SCOPE = "stellarcred:airdrop:other-2026";
const OTHER_NULLIFIER = "a62d602d6d06fc0c15334c48ac3a28a1e4a3db436f35b813fa67c06f890acffb";

const WALLET_A = "GA".padEnd(56, "A");
const WALLET_B = "GB".padEnd(56, "B");

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Fake on-chain state: one campaign, one spent-nullifier set. Models the
 * contract's semantics closely enough to exercise the SDK's decisions —
 * crucially, that the nullifier (not the address) is what gets spent.
 */
function fakeChain(opts: { verified?: Record<string, boolean>; active?: boolean } = {}) {
  const verified = opts.verified ?? { [WALLET_A]: true, [WALLET_B]: true };
  const spent = new Set<string>();
  const calls: Array<{ method: string; args: ContractArg[] }> = [];

  const nullifierOf = (wallet: string) => (verified[wallet] ? NULLIFIER : null);

  const reader: ContractReader = async (_contractId, method, args) => {
    calls.push({ method, args });
    const campaignId = args[0]?.type === "symbol" ? args[0].value : "";
    if (campaignId !== "drop1" && method !== "identity_commitment") {
      return method === "eligibility" ? ["CampaignNotFound"] : null;
    }
    switch (method) {
      case "get_campaign":
        return {
          scope: scopeBytes(SCOPE),
          credential_type: "kyc",
          min_threshold: null,
          trusted_issuers: null,
          amount: 100n,
          budget: 1000n,
          distributed: BigInt(spent.size) * 100n,
          claims: spent.size,
          max_claims: 0,
          start: 0n,
          end: 0n,
          active: opts.active ?? true,
        };
      case "nullifier_for": {
        const n = nullifierOf(args[1].value as string);
        return n ? hexToBytes(n) : null;
      }
      case "is_spent":
        return spent.has(toHex(args[1].value as Uint8Array));
      case "has_claimed": {
        const n = nullifierOf(args[1].value as string);
        return n ? spent.has(n) : false;
      }
      case "eligibility": {
        if (!(opts.active ?? true)) return ["CampaignInactive"];
        const n = nullifierOf(args[1].value as string);
        if (!n) return ["NotVerifiedHuman"];
        return spent.has(n) ? ["AlreadyClaimed"] : ["Eligible"];
      }
      case "claims_count":
        return spent.size;
      case "identity_commitment":
        return verified[args[0].value as string] ? hexToBytes(COMMITMENT) : null;
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };

  return { reader, spent, calls };
}

describe("deriveNullifier", () => {
  it("matches the on-chain sha256(commitment || scope) test vector", async () => {
    await expect(deriveNullifier(COMMITMENT, SCOPE)).resolves.toBe(NULLIFIER);
  });

  it("accepts raw bytes and a 0x-prefixed hex commitment identically", async () => {
    await expect(deriveNullifier(hexToBytes(COMMITMENT), SCOPE)).resolves.toBe(NULLIFIER);
    await expect(deriveNullifier(`0x${COMMITMENT}`, SCOPE)).resolves.toBe(NULLIFIER);
  });

  it("is unlinkable across app scopes", async () => {
    const a = await deriveNullifier(COMMITMENT, SCOPE);
    const b = await deriveNullifier(COMMITMENT, OTHER_SCOPE);
    expect(b).toBe(OTHER_NULLIFIER);
    expect(a).not.toBe(b);
  });

  it("rejects a commitment that is not 32 bytes", async () => {
    await expect(deriveNullifier("abcd", SCOPE)).rejects.toThrow(/32 bytes/);
    await expect(deriveNullifier("nothex", SCOPE)).rejects.toThrow(/hex/);
  });
});

describe("decoders", () => {
  it("normalises every enum encoding the RPC layer may return", () => {
    expect(decodeEligibility(["Eligible"])).toBe("Eligible");
    expect(decodeEligibility("AlreadyClaimed")).toBe("AlreadyClaimed");
    expect(decodeEligibility({ tag: "BudgetExhausted", values: [] })).toBe("BudgetExhausted");
    expect(() => decodeEligibility(["Nonsense"])).toThrow(/Unrecognised/);
  });

  it("decodes a campaign struct, exposing the scope as hex and text", () => {
    const campaign = decodeCampaign({
      scope: scopeBytes(SCOPE),
      credential_type: "kyc",
      min_threshold: 18n,
      trusted_issuers: ["GISSUER"],
      amount: 100n,
      budget: 1000n,
      distributed: 200n,
      claims: 2,
      max_claims: 0,
      start: 0n,
      end: 0n,
      active: true,
    });
    expect(campaign).toMatchObject({
      scopeText: SCOPE,
      credentialType: "kyc",
      minThreshold: 18,
      amount: 100n,
      claims: 2,
      active: true,
    });
    expect(campaign?.scope).toBe(toHex(scopeBytes(SCOPE)));
    expect(decodeCampaign(null)).toBeNull();
  });
});

describe("createHumanClaim", () => {
  it("requires a contract id", () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => createHumanClaim({})).toThrow(/contractId/);
  });

  it("reports an eligible verified human and their nullifier", async () => {
    const chain = fakeChain();
    const drop = createHumanClaim({ contractId: "CDROP", reader: chain.reader });

    const check = await drop.canClaim("drop1", WALLET_A);
    expect(check).toEqual({
      eligible: true,
      reason: "Eligible",
      message: ELIGIBILITY_REASONS.Eligible,
      nullifier: NULLIFIER,
    });
    expect(await drop.hasClaimed("drop1", WALLET_A)).toBe(false);
  });

  /** The anti-Sybil property, from the SDK's point of view. */
  it("reports AlreadyClaimed for a second wallet belonging to the same human", async () => {
    const chain = fakeChain();
    const drop = createHumanClaim({ contractId: "CDROP", reader: chain.reader });

    // Wallet A claims (the contract would burn the nullifier).
    const nullifier = await drop.nullifierFor("drop1", WALLET_A);
    expect(nullifier).toBe(NULLIFIER);
    chain.spent.add(nullifier!);

    // Wallet B is a different address but the same human.
    expect(await drop.nullifierFor("drop1", WALLET_B)).toBe(NULLIFIER);
    expect(await drop.hasClaimed("drop1", WALLET_B)).toBe(true);
    const check = await drop.canClaim("drop1", WALLET_B);
    expect(check.eligible).toBe(false);
    expect(check.reason).toBe("AlreadyClaimed");
    expect(check.message).toMatch(/already claimed/i);
    expect(await drop.isSpent("drop1", NULLIFIER)).toBe(true);
  });

  it("reports NotVerifiedHuman without a credential, and never leaks a nullifier", async () => {
    const chain = fakeChain({ verified: { [WALLET_A]: false } });
    const drop = createHumanClaim({ contractId: "CDROP", reader: chain.reader });

    const check = await drop.canClaim("drop1", WALLET_A);
    expect(check.eligible).toBe(false);
    expect(check.reason).toBe("NotVerifiedHuman");
    expect(check.nullifier).toBeNull();
  });

  it("surfaces campaign-level states (missing / paused)", async () => {
    const missing = createHumanClaim({ contractId: "CDROP", reader: fakeChain().reader });
    expect((await missing.canClaim("nope", WALLET_A)).reason).toBe("CampaignNotFound");
    expect(await missing.campaign("nope")).toBeNull();

    const paused = createHumanClaim({
      contractId: "CDROP",
      reader: fakeChain({ active: false }).reader,
    });
    expect((await paused.canClaim("drop1", WALLET_A)).reason).toBe("CampaignInactive");
  });

  it("reads campaign config and claim counters", async () => {
    const chain = fakeChain();
    const drop = createHumanClaim({ contractId: "CDROP", reader: chain.reader });
    chain.spent.add(NULLIFIER);

    const campaign = await drop.campaign("drop1");
    expect(campaign?.scopeText).toBe(SCOPE);
    expect(campaign?.credentialType).toBe("kyc");
    expect(campaign?.amount).toBe(100n);
    expect(await drop.claimsCount("drop1")).toBe(1);
  });

  it("derives the same nullifier from an on-chain commitment as the contract does", async () => {
    const chain = fakeChain();
    const drop = createHumanClaim({
      contractId: "CDROP",
      registryId: "CREGISTRY",
      reader: chain.reader,
    });

    const commitment = await drop.identityCommitment(WALLET_A, "kyc");
    expect(commitment).toBe(COMMITMENT);
    await expect(drop.deriveNullifier(commitment!, SCOPE)).resolves.toBe(
      await drop.nullifierFor("drop1", WALLET_A),
    );
  });

  it("explains that identityCommitment needs the registry address", async () => {
    const drop = createHumanClaim({ contractId: "CDROP", reader: fakeChain().reader });
    await expect(drop.identityCommitment(WALLET_A, "kyc")).rejects.toThrow(/registryId/);
  });

  it("times out a hung read instead of hanging the caller", async () => {
    vi.useFakeTimers();
    const drop = createHumanClaim({
      contractId: "CDROP",
      requestTimeoutMs: 50,
      reader: () => new Promise(() => {}),
    });
    const pending = drop.claimsCount("drop1");
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });
});
