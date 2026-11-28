import { describe, expect, it } from "vitest";
import {
  canonicalizeUniquenessPayload,
  createUniquenessAttestation,
  sameUniquenessSubject,
} from "./uniqueness";

describe("uniqueness attestations", () => {
  it("canonicalizes fields deterministically", () => {
    expect(
      canonicalizeUniquenessPayload({
        wallet: " GABC ",
        campaignId: " drop-1 ",
        scope: "airdrop",
        epoch: 7,
        issuer: " GISSUER ",
      }),
    ).toBe(
      '{"campaignId":"drop-1","epoch":"7","issuer":"GISSUER","scope":"airdrop","wallet":"GABC"}',
    );
  });

  it("creates stable nullifiers for the same subject", async () => {
    const first = await createUniquenessAttestation({
      wallet: "GABC",
      campaignId: "drop-1",
      scope: "leaderboard",
      epoch: "2026-09",
    });
    const second = await createUniquenessAttestation({
      scope: "leaderboard",
      campaignId: "drop-1",
      wallet: "GABC",
      epoch: "2026-09",
    });

    expect(first.nullifier).toMatch(/^[a-f0-9]{64}$/);
    expect(first.nullifier).toBe(second.nullifier);
    expect(sameUniquenessSubject(first, second)).toBe(true);
  });

  it("separates campaigns so leaderboards cannot reuse a quota nullifier", async () => {
    const quota = await createUniquenessAttestation({
      wallet: "GABC",
      campaignId: "drop-1",
      scope: "quota",
    });
    const leaderboard = await createUniquenessAttestation({
      wallet: "GABC",
      campaignId: "drop-1",
      scope: "leaderboard",
    });

    expect(quota.nullifier).not.toBe(leaderboard.nullifier);
    expect(sameUniquenessSubject(quota, leaderboard)).toBe(false);
  });
});
