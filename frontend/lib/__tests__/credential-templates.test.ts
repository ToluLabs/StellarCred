import { describe, it, expect } from "vitest";
import {
  CREDENTIAL_TEMPLATES,
  getTemplatesByType,
  getTemplateById,
} from "../credential-templates";
import { TYPE_META } from "../credential";

describe("Credential Templates Gallery (#411)", () => {
  it("defines data-driven credential templates with required fields", () => {
    expect(CREDENTIAL_TEMPLATES.length).toBeGreaterThanOrEqual(6);

    for (const t of CREDENTIAL_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.badge).toBeTruthy();
      expect(t.defaultExpiry).toBeTruthy();
      expect(t.category).toMatch(/^(finance|compliance|identity|work)$/);
      expect(TYPE_META[t.type]).toBeDefined();
    }
  });

  it("includes Accredited Investor, Age 18+, EU Resident, and Proof of Funds templates", () => {
    const ids = CREDENTIAL_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("accredited-investor");
    expect(ids).toContain("age-18");
    expect(ids).toContain("eu-resident");
    expect(ids).toContain("proof-of-funds-50k");

    const accredited = getTemplateById("accredited-investor")!;
    expect(accredited.type).toBe("accreditation");
    expect(Number(accredited.defaultAttribute)).toBeGreaterThanOrEqual(1000000);

    const euResident = getTemplateById("eu-resident")!;
    expect(euResident.type).toBe("jurisdiction");
    expect(euResident.defaultAttribute).toBe("276"); // Germany ISO code

    const age18 = getTemplateById("age-18")!;
    expect(age18.type).toBe("age");
    expect(age18.defaultAttribute).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("filters templates by credential type", () => {
    const ageTemplates = getTemplatesByType("age");
    expect(ageTemplates.length).toBeGreaterThanOrEqual(2);
    expect(ageTemplates.every((t) => t.type === "age")).toBe(true);

    const empty = getTemplatesByType("unknown" as unknown as import("../stellar").CredentialType);
    expect(empty).toEqual([]);
  });

  it("retrieves template by id", () => {
    const found = getTemplateById("proof-of-funds-50k");
    expect(found).toBeDefined();
    expect(found?.name).toContain("Proof of Funds");
    expect(found?.type).toBe("funds");

    const notFound = getTemplateById("non-existent");
    expect(notFound).toBeUndefined();
  });
});
