import { describe, it, expect } from "vitest";
import {
  evaluateClaimLifecycle,
  getLifecycleUiStatus,
  evaluateContractClaimResponse,
} from "../claim-expiry-lifecycle";

describe("claim-expiry-lifecycle (#980, #1006)", () => {
  const now = 1700000000;

  it("classifies active valid proof when within expiry and storage TTL is positive", () => {
    const state = evaluateClaimLifecycle({
      nowSec: now,
      verifiedAt: now - 3600,
      expirySec: now + 86400 * 30,
      storageTtlLedgers: 50000,
      isArchived: false,
    });
    expect(state).toBe("active_valid");
    expect(getLifecycleUiStatus(state)).toBe("proved");
  });

  it("classifies active expired proof when now >= expiry even if storage entry exists", () => {
    const state = evaluateClaimLifecycle({
      nowSec: now,
      verifiedAt: now - 86400 * 60,
      expirySec: now - 3600,
      storageTtlLedgers: 20000,
      isArchived: false,
    });
    expect(state).toBe("active_expired");
    expect(getLifecycleUiStatus(state)).toBe("expired");
  });

  it("strictly treats now === expirySec as expired matching contract comparison", () => {
    const state = evaluateClaimLifecycle({
      nowSec: now,
      verifiedAt: now - 3600,
      expirySec: now,
      storageTtlLedgers: 20000,
      isArchived: false,
    });
    expect(state).toBe("active_expired");
    expect(getLifecycleUiStatus(state)).toBe("expired");
  });

  it("classifies storage archived when entry TTL reaches 0 or isArchived is true", () => {
    const state = evaluateClaimLifecycle({
      nowSec: now,
      verifiedAt: now - 3600,
      expirySec: now + 86400 * 30,
      storageTtlLedgers: 0,
      isArchived: true,
    });
    expect(state).toBe("storage_archived");
    expect(getLifecycleUiStatus(state)).toBe("unproved");
  });

  it("classifies never proved when verifiedAt is missing or zero", () => {
    const state = evaluateClaimLifecycle({
      nowSec: now,
      verifiedAt: 0,
      expirySec: 0,
    });
    expect(state).toBe("never_proved");
    expect(getLifecycleUiStatus(state)).toBe("unproved");
  });

  describe("evaluateContractClaimResponse (contract parity #1006)", () => {
    it("maps (true, verified_at, expiry) to active_valid and proved UI status", () => {
      const state = evaluateContractClaimResponse([true, now - 500, now + 1000], now);
      expect(state).toBe("active_valid");
      expect(getLifecycleUiStatus(state)).toBe("proved");
    });

    it("maps (false, verified_at, expiry) to active_expired and expired UI status", () => {
      const state = evaluateContractClaimResponse([false, now - 1500, now - 500], now);
      expect(state).toBe("active_expired");
      expect(getLifecycleUiStatus(state)).toBe("expired");
    });

    it("maps (false, 0, 0) to never_proved or storage_archived and unproved UI status", () => {
      const stateUnproved = evaluateContractClaimResponse([false, 0, 0], now, false);
      expect(stateUnproved).toBe("never_proved");
      expect(getLifecycleUiStatus(stateUnproved)).toBe("unproved");

      const stateArchived = evaluateContractClaimResponse([false, 0, 0], now, true);
      expect(stateArchived).toBe("storage_archived");
      expect(getLifecycleUiStatus(stateArchived)).toBe("unproved");
    });
  });
});
