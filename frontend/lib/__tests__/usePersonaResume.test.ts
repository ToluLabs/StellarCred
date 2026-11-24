import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePersonaResume } from "../hooks/usePersonaResume";
import {
  savePersonaPending,
  loadPersonaPending,
  clearStalePersonaPending,
  PERSONA_PENDING_KEY,
} from "../persona-pending";

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

describe("usePersonaResume and Persona pending session handling", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  describe("sessionStorage PII safety & lifecycle", () => {
    it("ensures saved Persona pending payload is completely stripped of PII fields", () => {
      // Simulate attempting to save identity fields
      savePersonaPending({
        credential_types: ["kyc"],
        holder: "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ",
        issuerId: "GISSUER123",
        issuerName: "Test Issuer",
        expiry: "90 days",
        claimParams: {
          threshold_years: "21",
          // Sensitive keys that must NEVER be persisted
          date_of_birth: "1990-01-01",
          country_code: "US",
          first_name: "Alice",
        } as unknown as Record<string, unknown>,
      });

      const raw = sessionStorage.getItem(PERSONA_PENDING_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);

      expect(parsed.credential_types).toEqual(["kyc"]);
      expect(parsed.holder).toBe("GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ");
      expect(parsed.claimParams.threshold_years).toBe("21");

      // Verify PII fields were stripped
      expect(parsed.claimParams.date_of_birth).toBeUndefined();
      expect(parsed.claimParams.country_code).toBeUndefined();
      expect(parsed.claimParams.first_name).toBeUndefined();
      expect(raw).not.toContain("1990-01-01");
      expect(raw).not.toContain("Alice");
    });

    it("clears pending payload on read (read-and-clear)", () => {
      savePersonaPending({
        credential_types: ["kyc"],
        holder: "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ",
        issuerId: "GISSUER123",
      });

      expect(sessionStorage.getItem(PERSONA_PENDING_KEY)).toBeTruthy();
      const loaded = loadPersonaPending();
      expect(loaded).toBeTruthy();
      expect(sessionStorage.getItem(PERSONA_PENDING_KEY)).toBeNull();
    });

    it("clearStalePersonaPending wipes storage if no inquiry-id is present on mount", () => {
      savePersonaPending({
        credential_types: ["kyc"],
        holder: "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ",
        issuerId: "GISSUER123",
      });

      clearStalePersonaPending(false);
      expect(sessionStorage.getItem(PERSONA_PENDING_KEY)).toBeNull();
    });

    it("clearStalePersonaPending preserves storage if inquiry-id is present", () => {
      savePersonaPending({
        credential_types: ["kyc"],
        holder: "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ",
        issuerId: "GISSUER123",
      });

      clearStalePersonaPending(true);
      expect(sessionStorage.getItem(PERSONA_PENDING_KEY)).toBeTruthy();
    });
  });

  describe("usePersonaResume hook execution", () => {
    const mockCred = {
      type: "kyc" as const,
      holder: "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ",
      commitment: "0x1234",
      issuedAt: 1700000000,
      expiry: "90 days",
      issuerId: "GISSUER123",
      issuerSignature: "sig",
    };

    it("polls /api/persona/result and invokes onSuccess when ready", async () => {
      const onSuccess = vi.fn();
      const onBusyChange = vi.fn();

      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ready: true,
          credentials: [mockCred],
        }),
      } as unknown as Response);

      savePersonaPending({
        credential_types: ["kyc"],
        holder: "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ",
        issuerId: "GISSUER123",
      });

      renderHook(() =>
        usePersonaResume({
          personaInquiryId: "inq_test123",
          address: "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ",
          onSuccess,
          onBusyChange,
          fetchFn: fetchFn as unknown as typeof fetch,
        }),
      );

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith([mockCred]);
      });

      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining("/api/persona/result?inquiry_id=inq_test123"),
      );
    });

    it("handles failure status from /api/persona/result", async () => {
      const onSuccess = vi.fn();
      const onError = vi.fn();

      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ready: false,
          status: "failed",
          error: "Identity verification was declined",
        }),
      } as unknown as Response);

      renderHook(() =>
        usePersonaResume({
          personaInquiryId: "inq_failed",
          address: "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ",
          onSuccess,
          onError,
          fetchFn: fetchFn as unknown as typeof fetch,
        }),
      );

      await waitFor(() => {
        expect(onError).toHaveBeenCalledWith(
          expect.stringContaining("Identity verification was declined"),
        );
      });
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("falls back to POST /api/issue when polling limits are reached", async () => {
      const onSuccess = vi.fn();
      let callCount = 0;

      const fetchFn = vi.fn().mockImplementation((url, init) => {
        callCount++;
        if (url.includes("/api/persona/result")) {
          // Return not ready
          return Promise.resolve({
            ok: true,
            json: async () => ({ ready: false, status: "pending" }),
          } as Response);
        }
        if (url.includes("/api/issue") && init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ credentials: [mockCred] }),
          } as Response);
        }
        return Promise.reject(new Error("Unexpected endpoint"));
      });

      savePersonaPending({
        credential_types: ["kyc"],
        holder: "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ",
        issuerId: "GISSUER123",
      });

      renderHook(() =>
        usePersonaResume({
          personaInquiryId: "inq_timeout",
          address: "GBJPTQJ74N2O4SQUB2T2U3M2WJ27GZTXOQ2HQZ6A2O4SQUB2T2U3M2WJ",
          onSuccess,
          maxPollAttempts: 1, // trigger fallback on next attempt
          pollIntervalMs: 10,
          fetchFn: fetchFn as unknown as typeof fetch,
        }),
      );

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith([mockCred]);
      });

      expect(callCount).toBeGreaterThanOrEqual(2);

      expect(fetchFn).toHaveBeenCalledWith(
        "/api/issue",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "x-request-id": expect.any(String),
          }),
          body: expect.stringContaining("inq_timeout"),
        }),
      );
    });
  });
});
