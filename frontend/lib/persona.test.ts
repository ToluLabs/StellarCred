// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  alpha2ToNumeric,
  createPersonaInquiry,
  retrievePersonaInquiry,
  resolvePersonaKYC,
} from "./persona";

describe("lib/persona", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("alpha2ToNumeric", () => {
    it("converts ISO alpha-2 codes to numeric codes", () => {
      expect(alpha2ToNumeric("US")).toBe("840");
      expect(alpha2ToNumeric("NG")).toBe("566");
      expect(alpha2ToNumeric("DE")).toBe("276");
      expect(alpha2ToNumeric("GB")).toBe("826");
    });

    it("falls back to 0 for unknown country codes", () => {
      expect(alpha2ToNumeric("XX")).toBe("0");
    });
  });

  describe("createPersonaInquiry", () => {
    it("creates an inquiry and returns url and id", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { id: "inq_test123" },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await createPersonaInquiry(
        "itmpl_test",
        "http://localhost:3000/verify",
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.id).toBe("inq_test123");
      expect(result.url).toBe("https://withpersona.com/verify?inquiry-id=inq_test123");
    });

    it("throws if API returns an error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "Template not found" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        createPersonaInquiry("itmpl_invalid", "http://localhost:3000/verify"),
      ).rejects.toThrow("Persona: failed to create inquiry");
    });
  });

  describe("retrievePersonaInquiry", () => {
    it("retrieves inquiry status and fields", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            attributes: {
              status: "approved",
              fields: {
                birthdate: { value: "1990-01-01" },
              },
            },
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await retrievePersonaInquiry("inq_123");
      expect(result.status).toBe("approved");
      expect(result.fields["birthdate"].value).toBe("1990-01-01");
    });
  });

  describe("resolvePersonaKYC", () => {
    it("returns ok: true with dob and countryNumeric for approved inquiry", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            attributes: {
              status: "approved",
              fields: {
                birthdate: { value: "1995-10-25" },
                "selected-country-code": { value: "US" },
              },
            },
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await resolvePersonaKYC("inq_123");
      expect(result.ok).toBe(true);
      expect(result.dob).toBe("1995-10-25");
      expect(result.countryNumeric).toBe("840");
    });

    it("returns ok: false for non-approved inquiries", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            attributes: {
              status: "declined",
              fields: {},
            },
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await resolvePersonaKYC("inq_123");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("declined");
    });
  });
});
