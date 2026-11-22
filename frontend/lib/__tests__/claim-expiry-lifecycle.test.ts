import { describe, it, expect } from "vitest";
import { evaluateClaimLifecycle, getLifecycleUiStatus } from "../claim-expiry-lifecycle";

describe("claim-expiry-lifecycle (#980)", () => {
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
});
