import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  invalidateWalletSessionCache,
  invalidateCredentialCache,
  registerCacheInvalidationListener,
  CACHE_INVALIDATION_EVENT,
} from "../cache-invalidation";
import * as proofCacheModule from "../proof-cache";
import * as credentialModule from "../credential";
import * as proofModule from "../proof";

describe("cache invalidation for wallet session and credential updates (#942)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    sessionStorage.setItem("stellarcred:wallet-session", "active-session-token");
    sessionStorage.setItem("stellarcred:credential-cache", JSON.stringify({ creds: [1, 2] }));
    sessionStorage.setItem("stellarcred:trust-cache", JSON.stringify({ trusted: true }));
    sessionStorage.setItem("stellarcred:network-cache", "testnet");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears transient sessionStorage keys and dispatches event on disconnect", () => {
    const clearProofSpy = vi
      .spyOn(proofCacheModule, "clearAllProofCache")
      .mockImplementation(() => {});
    const lockCredSpy = vi
      .spyOn(credentialModule, "lockCredentialStore")
      .mockImplementation(() => {});
    const destroySpy = vi.spyOn(proofModule, "destroyAllBackends").mockResolvedValue(undefined);

    let eventDetail: unknown = null;
    const handler = (e: Event) => {
      eventDetail = (e as CustomEvent).detail;
    };
    window.addEventListener(CACHE_INVALIDATION_EVENT, handler);

    invalidateWalletSessionCache({ reason: "disconnect", address: "GABC123" });

    expect(sessionStorage.getItem("stellarcred:wallet-session")).toBeNull();
    expect(sessionStorage.getItem("stellarcred:credential-cache")).toBeNull();
    expect(sessionStorage.getItem("stellarcred:trust-cache")).toBeNull();
    expect(sessionStorage.getItem("stellarcred:network-cache")).toBeNull();

    expect(clearProofSpy).toHaveBeenCalledTimes(1);
    expect(lockCredSpy).toHaveBeenCalledTimes(1);
    expect(destroySpy).toHaveBeenCalledTimes(1);

    expect(eventDetail).toMatchObject({
      reason: "disconnect",
      address: "GABC123",
    });

    window.removeEventListener(CACHE_INVALIDATION_EVENT, handler);
  });

  it("notifies in-memory registered listeners on account change", () => {
    const listener = vi.fn();
    const unregister = registerCacheInvalidationListener(listener);

    invalidateWalletSessionCache({ reason: "account-change", address: "GXYZ999" });

    expect(listener).toHaveBeenCalledWith({
      reason: "account-change",
      address: "GXYZ999",
    });

    unregister();
    listener.mockClear();

    invalidateWalletSessionCache({ reason: "refresh" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("handles network-change reason deterministically", () => {
    let capturedReason = "";
    const handler = (e: Event) => {
      capturedReason = (e as CustomEvent).detail.reason;
    };
    window.addEventListener(CACHE_INVALIDATION_EVENT, handler);

    invalidateWalletSessionCache({ reason: "network-change", address: "GADDR" });
    expect(capturedReason).toBe("network-change");

    window.removeEventListener(CACHE_INVALIDATION_EVENT, handler);
  });

  it("triggers invalidation on credential updates (issuance/revocation)", () => {
    const listener = vi.fn();
    const unregister = registerCacheInvalidationListener(listener);

    invalidateCredentialCache("issuance");
    expect(listener).toHaveBeenCalledWith({
      reason: "credential-update",
    });

    unregister();
  });

  it("handles storage exceptions gracefully without crashing", () => {
    const originalRemove = sessionStorage.removeItem;
    sessionStorage.removeItem = vi.fn().mockImplementation(() => {
      throw new Error("storage quota exceeded or blocked");
    });

    expect(() => {
      invalidateWalletSessionCache({ reason: "refresh" });
    }).not.toThrow();

    sessionStorage.removeItem = originalRemove;
  });
});
