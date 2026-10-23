// @vitest-environment node
//
// Node environment, not the workspace-default jsdom: `@stellarcred/issuer`
// refuses to load when `window` exists (see its server-only guard), and
// validate.ts imports CREDENTIAL_TYPES from it.
//
// Unit coverage for the parsing / normalisation / validation stage of
// POST /api/issue. These assert the behaviour the route used to inline:
// the two accepted body shapes, the order failures are reported in, and the
// issuer-registration check that decides whether the selected issuer can be
// served by this deployment at all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { fetchIssuerPubkey } from "@/lib/issuer-registry";
import { localIssuerPubkeyBytes } from "@/lib/issuer-service";
import {
  normalizeIssueRequest,
  parseIssueBody,
  validateIssueRequest,
  validateIssuerRegistration,
  type IssueBody,
  type NormalizedIssueRequest,
} from "../validate";

// The module reads env at call time; a mutable object keeps every test's
// configuration local without re-importing the module per case.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, unknown>,
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/issuer-registry", () => ({ fetchIssuerPubkey: vi.fn() }));
vi.mock("@/lib/issuer-service", () => ({
  localIssuerPubkeyBytes: vi.fn(),
  issueAndAuditCredentials: vi.fn(),
}));

const HOLDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ISSUER_ID = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";
const REQUEST_ID = "req_validation_0001";

/** The simulation-account fallback used when no issuer address is configured. */
const SIM_ACCOUNT_FALLBACK = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function normalized(overrides: Partial<IssueBody> = {}): NormalizedIssueRequest {
  return normalizeIssueRequest({
    credential_types: ["kyc"],
    holder: HOLDER,
    issuerId: ISSUER_ID,
    ...overrides,
  });
}

beforeEach(() => {
  delete mockEnv.NEXT_PUBLIC_ISSUER_REGISTRY_ID;
  delete mockEnv.NEXT_PUBLIC_ISSUER_ADDRESS;
  vi.mocked(fetchIssuerPubkey).mockReset();
  vi.mocked(localIssuerPubkeyBytes).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseIssueBody", () => {
  function requestWith(body: string, headers: Record<string, string> = {}) {
    return new NextRequest("http://localhost/api/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
  }

  it("parses a well-formed JSON body", async () => {
    const parsed = await parseIssueBody(
      requestWith(JSON.stringify({ type: "age", holder: HOLDER })),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.body.type).toBe("age");
  });

  it("reports malformed JSON as a 400 invalid_json error", async () => {
    const parsed = await parseIssueBody(requestWith("{not json"));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.status).toBe(400);
      expect(parsed.error.code).toBe("invalid_json");
    }
  });

  it("rejects an oversized body before reading it", async () => {
    const parsed = await parseIssueBody(
      requestWith("{}", { "Content-Length": String(10 * 1024 * 1024) }),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.status).toBe(413);
      expect(parsed.error.code).toBe("payload_too_large");
    }
  });
});

describe("normalizeIssueRequest", () => {
  it("normalises the multi-claim shape and applies the documented defaults", () => {
    const request = normalizeIssueRequest({
      credential_types: ["kyc", "age"],
      holder: HOLDER,
      issuerId: ISSUER_ID,
      attributes: { date_of_birth: "1995-06-15" },
    });

    expect(request.credentialTypes).toEqual(["kyc", "age"]);
    expect(request.holder).toBe(HOLDER);
    expect(request.issuerId).toBe(ISSUER_ID);
    expect(request.issuerName).toBe("StellarCred Authority");
    expect(request.expiry).toBe("90 days");
    expect(request.attributes).toEqual({ date_of_birth: "1995-06-15" });
  });

  it("normalises the legacy single-type shape to one credential type", () => {
    const request = normalizeIssueRequest({
      type: "kyc",
      holder: HOLDER,
      issuerId: ISSUER_ID,
      issuerName: "Demo Bank",
      expiry: "30 days",
    });

    expect(request.credentialTypes).toEqual(["kyc"]);
    expect(request.issuerName).toBe("Demo Bank");
    expect(request.expiry).toBe("30 days");
  });

  it("folds the legacy attribute into the field each type actually reads", () => {
    expect(normalizeIssueRequest({ type: "age", attribute: "1995-06-15" }).attributes).toEqual({
      date_of_birth: "1995-06-15",
    });
    expect(normalizeIssueRequest({ type: "income", attribute: "90000" }).attributes).toEqual({
      income: "90000",
    });
    expect(
      normalizeIssueRequest({ type: "jurisdiction", attribute: "566" }).attributes,
    ).toEqual({ country_code: "566" });
    expect(
      normalizeIssueRequest({ type: "employment", attribute: "senior" }).attributes,
    ).toEqual({ seniority: "senior" });
  });

  it("does not overwrite an explicitly supplied attribute with the legacy field", () => {
    const request = normalizeIssueRequest({
      type: "age",
      attribute: "legacy-value",
      attributes: { date_of_birth: "1990-01-01" },
    });
    expect(request.attributes.date_of_birth).toBe("1990-01-01");
  });

  it("leaves the legacy attribute unmapped for a type without a mapping", () => {
    const request = normalizeIssueRequest({ type: "accreditation", attribute: "x" });
    expect(request.attributes).toEqual({});
  });

  it("treats a body with no type at all as zero credential types", () => {
    expect(normalizeIssueRequest({ holder: HOLDER }).credentialTypes).toEqual([]);
  });

  it("does not mutate the caller's attributes object", () => {
    const attributes = { date_of_birth: "1995-06-15" };
    normalizeIssueRequest({ type: "age", attribute: "other", attributes });
    expect(attributes).toEqual({ date_of_birth: "1995-06-15" });
  });
});

describe("validateIssueRequest", () => {
  it("accepts a valid request and narrows holder/issuerId to strings", () => {
    const result = validateIssueRequest(normalized(), REQUEST_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.holder).toBe(HOLDER);
      expect(result.request.issuerId).toBe(ISSUER_ID);
    }
  });

  it("logs request_received once per requested credential type", () => {
    const infoSpy = vi.spyOn(logger, "info");
    validateIssueRequest(normalized({ credential_types: ["kyc", "age"] }), REQUEST_ID);

    const received = infoSpy.mock.calls.filter(
      (call) => (call[0] as { event?: string }).event === "request_received",
    );
    expect(received).toHaveLength(2);
    expect(received.map((call) => (call[0] as { credentialType: string }).credentialType)).toEqual([
      "kyc",
      "age",
    ]);
  });

  it("rejects a request with no credential type", () => {
    const result = validateIssueRequest(normalized({ credential_types: [] }), REQUEST_ID);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        status: 400,
        error: "credential_types must contain at least one type",
      },
    });
  });

  it("rejects an unknown credential type and logs the rejection per type", () => {
    const infoSpy = vi.spyOn(logger, "info");
    const result = validateIssueRequest(
      normalized({ credential_types: ["kyc", "not-a-real-type"] }),
      REQUEST_ID,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { status: 400, error: "Invalid credential type: not-a-real-type" },
    });

    const verdicts = infoSpy.mock.calls.filter(
      (call) => (call[0] as { event?: string }).event === "validation_result",
    );
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((call) => (call[0] as { outcome: string }).outcome === "invalid_type")).toBe(
      true,
    );
  });

  it("rejects a request missing the holder address", () => {
    const result = validateIssueRequest(normalized({ holder: undefined }), REQUEST_ID);
    expect(result).toMatchObject({
      ok: false,
      failure: { status: 400, error: "holder address is required" },
    });
  });

  it("rejects a request missing the issuerId", () => {
    const result = validateIssueRequest(normalized({ issuerId: undefined }), REQUEST_ID);
    expect(result).toMatchObject({
      ok: false,
      failure: { status: 400, error: "issuerId is required" },
    });
  });

  it("reports the first failure in the documented order", () => {
    // Both wrong: the invalid-type verdict wins over the missing holder.
    const result = validateIssueRequest(
      normalized({ credential_types: ["nope"], holder: undefined }),
      REQUEST_ID,
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { error: "Invalid credential type: nope" },
    });
  });
});

describe("validateIssuerRegistration", () => {
  const LOCAL_KEY = Buffer.from([1, 2, 3, 4]);

  it("skips the check entirely when no IssuerRegistry is configured", async () => {
    const failure = await validateIssuerRegistration(ISSUER_ID);
    expect(failure).toBeNull();
    expect(fetchIssuerPubkey).not.toHaveBeenCalled();
  });

  it("rejects an issuer that is not registered on chain", async () => {
    mockEnv.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "CREGISTRY";
    vi.mocked(fetchIssuerPubkey).mockResolvedValue(null);

    const failure = await validateIssuerRegistration(ISSUER_ID);

    expect(failure).toEqual({
      status: 400,
      error: "Selected issuer is not registered on IssuerRegistry.",
    });
    expect(fetchIssuerPubkey).toHaveBeenCalledWith(ISSUER_ID, SIM_ACCOUNT_FALLBACK);
  });

  it("rejects when the local signing key does not match the registered key", async () => {
    mockEnv.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "CREGISTRY";
    vi.mocked(fetchIssuerPubkey).mockResolvedValue(new Uint8Array(64).fill(0xff));
    vi.mocked(localIssuerPubkeyBytes).mockReturnValue(LOCAL_KEY);

    const failure = await validateIssuerRegistration(ISSUER_ID);

    expect(failure?.status).toBe(403);
    expect(failure?.error).toMatch(/ISSUER_PRIVATE_KEY does not match/);
  });

  it("accepts when the registered key matches the local signing key", async () => {
    mockEnv.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "CREGISTRY";
    vi.mocked(fetchIssuerPubkey).mockResolvedValue(Uint8Array.from(LOCAL_KEY));
    vi.mocked(localIssuerPubkeyBytes).mockReturnValue(LOCAL_KEY);

    await expect(validateIssuerRegistration(ISSUER_ID)).resolves.toBeNull();
  });

  it("writes nothing to the log stream — the verdict is returned, not logged", async () => {
    mockEnv.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "CREGISTRY";
    vi.mocked(fetchIssuerPubkey).mockResolvedValue(new Uint8Array(64).fill(0xab));
    vi.mocked(localIssuerPubkeyBytes).mockReturnValue(Buffer.from([0xcd, 0xef]));

    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");

    await validateIssuerRegistration(ISSUER_ID);

    // Key material must never reach a log line, so this stage emits none at
    // all rather than relying on an allowlist to drop the keys.
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
