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
        status: 400,
        json: async () => ({ error: "Template not found credential=secret" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        createPersonaInquiry("itmpl_invalid", "http://localhost:3000/verify"),
      ).rejects.toMatchObject({
        name: "VerificationError",
        code: "persona_create_http_400",
        category: "invalid_input",
      });
    });

    it("classifies transport failures without exposing provider details", async () => {
      const cause = new Error("socket credential=secret salt=secret");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));

      const error = await createPersonaInquiry("itmpl_test", "https://app.test/verify").catch(
        (caught) => caught,
      );
      expect(error).toMatchObject({
        code: "persona_unavailable",
        category: "network_error",
        cause,
      });
      expect(error.message).not.toMatch(/credential=secret|salt=secret/);
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

    it("rejects malformed provider responses without echoing them", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("provider body credential=secret salt=secret");
          },
        }),
      );

      const error = await retrievePersonaInquiry("inq_123").catch((caught) => caught);
      expect(error).toMatchObject({
        code: "persona_invalid_response",
        category: "configuration_error",
      });
      expect(error.message).not.toMatch(/credential=secret|salt=secret/);
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
      expect(result.error).toBe("Identity verification was declined.");
      expect(result.errorCategory).toBe("policy_rejection");
      expect(result.errorCode).toBe("persona_declined");
    });
  });
});
