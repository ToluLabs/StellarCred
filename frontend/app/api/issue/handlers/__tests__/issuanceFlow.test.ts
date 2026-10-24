// @vitest-environment node
//
// Node environment, not the workspace-default jsdom: `@stellarcred/issuer`
// refuses to load when `window` exists, and the flow's request/credential
// types come from it.
//
// Unit coverage for the orchestration stage of POST /api/issue: the Persona
// gate, the Plaid attestation, and signing. The route-level suites prove the
// end-to-end behaviour; these pin the decisions the flow makes on its own —
// which provider is called, with what, and what is returned when one fails.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "@/lib/logger";
import { createPersonaInquiry, resolvePersonaKYC } from "@/lib/persona";
import { registerPendingInquiry } from "@/lib/persona-webhook";
import { fetchPlaidBalance } from "@/lib/plaid";
import { issueAndAuditCredentials } from "@/lib/issuer-service";
import { reportError } from "@/lib/error-reporting";
import { runIssuanceFlow } from "../issuanceFlow";
import type { IssueRequest } from "../validate";

// Mutable env so each test configures Persona without re-importing modules.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, unknown>,
}));

vi.mock("@/lib/env", () => ({ env: mockEnv }));
vi.mock("@/lib/persona", () => ({
  createPersonaInquiry: vi.fn(),
  resolvePersonaKYC: vi.fn(),
}));
vi.mock("@/lib/persona-webhook", () => ({ registerPendingInquiry: vi.fn() }));
vi.mock("@/lib/plaid", () => ({ fetchPlaidBalance: vi.fn() }));
vi.mock("@/lib/issuer-service", () => ({
  issueAndAuditCredentials: vi.fn(),
  localIssuerPubkeyBytes: vi.fn(),
}));
vi.mock("@/lib/error-reporting", () => ({ reportError: vi.fn() }));

const HOLDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ISSUER_ID = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";
const REQUEST_ID = "req_flow_0001";
const ORIGIN = "https://app.example";
const CTX = { requestId: REQUEST_ID, origin: ORIGIN };

const TEMPLATE_ID = "itmpl_test";
const INQUIRY_ID = "inq_test_0001";

// Deliberately unrealistic identity strings, used to prove provider text is
// never echoed back in an error response.
const SENTINELS = {
  firstName: "Sentinelfirstname",
  lastName: "Sentinellastname",
  idNumber: "Sentinelidnumber",
} as const;

function request(overrides: Partial<IssueRequest> = {}): IssueRequest {
  return {
    credentialTypes: ["kyc"],
    holder: HOLDER,
    issuerId: ISSUER_ID,
    issuerName: "StellarCred Authority",
    expiry: "90 days",
    attributes: {},
    ...overrides,
  };
}

/** The credential shape `issueAndAuditCredentials` hands back. */
function credential(type: string, value = "ok") {
  return {
    type,
    value,
    commitment: "123456789",
    sig: [1, 2, 3],
    issuerPubX: new Array(32).fill(1),
    issuerPubY: new Array(32).fill(2),
    issuedAt: 1_700_000_000,
    holder: HOLDER,
    issuerId: ISSUER_ID,
    issuerName: "StellarCred Authority",
    expiry: "90 days",
    salt: "42",
  };
}

function captureLogs() {
  const events: Array<{ event?: string; outcome?: string; credentialType?: string }> = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      events.push(args[0] as (typeof events)[number]);
    });
  }
  return events;
}

beforeEach(() => {
  delete mockEnv.PERSONA_API_KEY;
  delete mockEnv.PERSONA_KYC_TEMPLATE_ID;
  delete mockEnv.NEXT_PUBLIC_STELLARCRED_BASE_URL;
  vi.mocked(createPersonaInquiry).mockReset();
  vi.mocked(resolvePersonaKYC).mockReset();
  vi.mocked(registerPendingInquiry).mockReset();
  vi.mocked(fetchPlaidBalance).mockReset();
  vi.mocked(issueAndAuditCredentials).mockReset();
  vi.mocked(reportError).mockReset();

  vi.mocked(issueAndAuditCredentials).mockResolvedValue([
    credential("kyc"),
  ] as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Persona gate", () => {
  it("skips identity verification in demo mode (no PERSONA_API_KEY)", async () => {
    const result = await runIssuanceFlow(request(), CTX);

    expect(createPersonaInquiry).not.toHaveBeenCalled();
    expect(resolvePersonaKYC).not.toHaveBeenCalled();
    expect(result.kind).toBe("issued");
  });

  it("returns a Persona redirect (not credentials) when the inquiry has not run yet", async () => {
    mockEnv.PERSONA_API_KEY = "test-persona-key";
    mockEnv.PERSONA_KYC_TEMPLATE_ID = TEMPLATE_ID;
    vi.mocked(createPersonaInquiry).mockResolvedValue({
      url: "https://withpersona.com/verify?inquiry-id=inq_test_0001",
      id: INQUIRY_ID,
    });

    const result = await runIssuanceFlow(
      request({ claimParams: { nested: { a: 1 } } as never }),
      CTX,
    );

    expect(result).toEqual({
      kind: "persona",
      personaUrl: "https://withpersona.com/verify?inquiry-id=inq_test_0001",
      inquiryId: INQUIRY_ID,
    });
    // The redirect stage must not sign anything.
    expect(issueAndAuditCredentials).not.toHaveBeenCalled();

    expect(createPersonaInquiry).toHaveBeenCalledWith(
      TEMPLATE_ID,
      `${ORIGIN}/verify`,
      HOLDER,
    );

    // The server-side pending-inquiry record gets exactly the non-PII issuance
    // context a webhook needs to finish the job.
    expect(registerPendingInquiry).toHaveBeenCalledWith(INQUIRY_ID, {
      holder: HOLDER,
      issuerId: ISSUER_ID,
      issuerName: "StellarCred Authority",
      expiry: "90 days",
      credentialTypes: ["kyc"],
      claimParams: { nested: { a: 1 } },
    });
  });

  it("carries the return URL through to Persona as an encoded /verify parameter", async () => {
    mockEnv.PERSONA_API_KEY = "test-persona-key";
    mockEnv.PERSONA_KYC_TEMPLATE_ID = TEMPLATE_ID;
    vi.mocked(createPersonaInquiry).mockResolvedValue({
      url: "https://withpersona.com/verify?inquiry-id=inq_test_0001",
      id: INQUIRY_ID,
    });

    await runIssuanceFlow(
      request({ returnUrl: "https://app.example/dashboard?tab=ids" }),
      CTX,
    );

    expect(createPersonaInquiry).toHaveBeenCalledWith(
      TEMPLATE_ID,
      `${ORIGIN}/verify?return_url=${encodeURIComponent(
        "https://app.example/dashboard?tab=ids",
      )}`,
      HOLDER,
    );
  });

  it("prefers the configured base URL over the request origin", async () => {
    mockEnv.PERSONA_API_KEY = "test-persona-key";
    mockEnv.PERSONA_KYC_TEMPLATE_ID = TEMPLATE_ID;
    mockEnv.NEXT_PUBLIC_STELLARCRED_BASE_URL = "https://issuer.example";
    vi.mocked(createPersonaInquiry).mockResolvedValue({
      url: "https://withpersona.com/verify?inquiry-id=inq_test_0001",
      id: INQUIRY_ID,
    });

    await runIssuanceFlow(request(), CTX);

    expect(createPersonaInquiry).toHaveBeenCalledWith(
      TEMPLATE_ID,
      "https://issuer.example/verify",
      HOLDER,
    );
  });

  it("fails closed when a Persona key is configured without a template", async () => {
    mockEnv.PERSONA_API_KEY = "test-persona-key";

    const result = await runIssuanceFlow(request(), CTX);

    expect(result).toEqual({
      kind: "error",
      status: 500,
      body: {
        error: "PERSONA_KYC_TEMPLATE_ID is required when PERSONA_API_KEY is set",
      },
    });
    expect(createPersonaInquiry).not.toHaveBeenCalled();
    expect(issueAndAuditCredentials).not.toHaveBeenCalled();
  });

  it("returns 403 when the provider declines the inquiry", async () => {
    mockEnv.PERSONA_API_KEY = "test-persona-key";
    mockEnv.PERSONA_KYC_TEMPLATE_ID = TEMPLATE_ID;
    vi.mocked(resolvePersonaKYC).mockResolvedValue({
      ok: false,
      error: "Persona KYC inquiry status: declined",
    });

    const result = await runIssuanceFlow(
      request({ personaInquiryId: INQUIRY_ID }),
      CTX,
    );

    expect(result).toEqual({
      kind: "error",
      status: 403,
      body: { error: "Persona KYC inquiry status: declined" },
    });
    expect(issueAndAuditCredentials).not.toHaveBeenCalled();
  });

  it("derives date_of_birth and country_code from an approved inquiry", async () => {
    mockEnv.PERSONA_API_KEY = "test-persona-key";
    mockEnv.PERSONA_KYC_TEMPLATE_ID = TEMPLATE_ID;
    vi.mocked(resolvePersonaKYC).mockResolvedValue({
      ok: true,
      dob: "1995-06-15",
      countryNumeric: "566",
    });

    const result = await runIssuanceFlow(
      request({ personaInquiryId: INQUIRY_ID, credentialTypes: ["kyc", "age"] }),
      CTX,
    );

    expect(result.kind).toBe("issued");
    expect(issueAndAuditCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialTypes: ["kyc", "age"],
        attributes: { date_of_birth: "1995-06-15", country_code: "566" },
      }),
    );
  });

  it("never echoes Persona's error text (which can carry identity fields)", async () => {
    mockEnv.PERSONA_API_KEY = "test-persona-key";
    mockEnv.PERSONA_KYC_TEMPLATE_ID = TEMPLATE_ID;
    vi.mocked(resolvePersonaKYC).mockRejectedValue(
      new Error(
        `Persona: failed to retrieve inquiry — ${JSON.stringify({
          first_name: SENTINELS.firstName,
          last_name: SENTINELS.lastName,
          id_number: SENTINELS.idNumber,
        })}`,
      ),
    );
    const events = captureLogs();

    const result = await runIssuanceFlow(
      request({ personaInquiryId: INQUIRY_ID }),
      CTX,
    );

    expect(result).toEqual({
      kind: "error",
      status: 502,
      body: {
        error: "Identity verification service is unavailable. Please try again.",
      },
    });

    const stream = JSON.stringify(result) + JSON.stringify(events);
    for (const value of Object.values(SENTINELS)) {
      expect(stream).not.toContain(value);
    }
    expect(issueAndAuditCredentials).not.toHaveBeenCalled();
  });
});

describe("Plaid attestation", () => {
  it("overwrites a caller-supplied balance with the verified aggregate", async () => {
    vi.mocked(fetchPlaidBalance).mockResolvedValue({
      ok: true,
      balance: 26500,
      sources: 2,
    });

    const result = await runIssuanceFlow(
      request({
        credentialTypes: ["funds"],
        attributes: { balance: "1" },
      }),
      CTX,
    );

    expect(result.kind).toBe("issued");
    expect(fetchPlaidBalance).toHaveBeenCalledWith(REQUEST_ID);
    expect(issueAndAuditCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ attributes: { balance: "26500" } }),
    );
  });

  it("propagates a provider failure verbatim and never signs", async () => {
    vi.mocked(fetchPlaidBalance).mockResolvedValue({
      ok: false,
      status: 502,
      code: "PLAID_ERROR",
      error: "Balance verification failed.",
    });

    const result = await runIssuanceFlow(
      request({ credentialTypes: ["funds"] }),
      CTX,
    );

    expect(result).toEqual({
      kind: "error",
      status: 502,
      body: { error: "Balance verification failed.", code: "PLAID_ERROR" },
    });
    expect(issueAndAuditCredentials).not.toHaveBeenCalled();
  });

  it("does not call Plaid when no funds credential was requested", async () => {
    await runIssuanceFlow(request({ credentialTypes: ["age"] }), CTX);
    expect(fetchPlaidBalance).not.toHaveBeenCalled();
  });
});

describe("issuance and stamping", () => {
  it("stamps every credential with the deployment and its circuit version", async () => {
    vi.mocked(issueAndAuditCredentials).mockResolvedValue([
      credential("kyc"),
      credential("age", "1995-06-15"),
    ] as never);

    const result = await runIssuanceFlow(
      request({ credentialTypes: ["kyc", "age"] }),
      CTX,
    );

    expect(result.kind).toBe("issued");
    if (result.kind !== "issued") return;

    expect(result.credentials).toHaveLength(2);
    for (const issued of result.credentials) {
      expect(issued.deployment.networkPassphrase).toBeTruthy();
      expect(issued.circuitVersion).toBe("1.0.0");
      expect(issued.circuitVkVersion).toBe(1);
    }
    expect(result.credentials.map((c) => c.type)).toEqual(["kyc", "age"]);
  });

  it("passes the request identity and signing context through unchanged", async () => {
    await runIssuanceFlow(
      request({
        credentialTypes: ["age"],
        issuerName: "Demo Bank",
        expiry: "30 days",
        attributes: { date_of_birth: "1995-06-15" },
        claimParams: { salt: "7" } as never,
      }),
      CTX,
    );

    expect(issueAndAuditCredentials).toHaveBeenCalledWith({
      credentialTypes: ["age"],
      holder: HOLDER,
      issuerId: ISSUER_ID,
      issuerName: "Demo Bank",
      expiry: "30 days",
      attributes: { date_of_birth: "1995-06-15" },
      claimParams: { salt: "7" },
      requestId: REQUEST_ID,
    });
  });

  it("returns a 500 with the signing error and reports it, per credential type", async () => {
    vi.mocked(issueAndAuditCredentials).mockRejectedValue(
      new Error("commitment computation rejected"),
    );
    const events = captureLogs();

    const result = await runIssuanceFlow(
      request({ credentialTypes: ["kyc", "age"] }),
      CTX,
    );

    expect(result).toEqual({
      kind: "error",
      status: 500,
      body: { error: "commitment computation rejected" },
    });

    const failures = events.filter((event) => event.event === "signing_failed");
    expect(failures.map((event) => event.credentialType)).toEqual(["kyc", "age"]);

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/api/issue",
        requestId: REQUEST_ID,
        status: 500,
      }),
    );
  });
});

describe("provider ordering", () => {
  it("runs Persona, then Plaid, then signing", async () => {
    mockEnv.PERSONA_API_KEY = "test-persona-key";
    mockEnv.PERSONA_KYC_TEMPLATE_ID = TEMPLATE_ID;
    vi.mocked(resolvePersonaKYC).mockResolvedValue({ ok: true, dob: "1995-06-15" });
    vi.mocked(fetchPlaidBalance).mockResolvedValue({ ok: true, balance: 1000 });

    const result = await runIssuanceFlow(
      request({ credentialTypes: ["kyc", "funds"], personaInquiryId: INQUIRY_ID }),
      CTX,
    );

    expect(result.kind).toBe("issued");

    const personaOrder = vi.mocked(resolvePersonaKYC).mock.invocationCallOrder[0];
    const plaidOrder = vi.mocked(fetchPlaidBalance).mock.invocationCallOrder[0];
    const signingOrder = vi.mocked(issueAndAuditCredentials).mock.invocationCallOrder[0];

    expect(personaOrder).toBeLessThan(plaidOrder);
    expect(plaidOrder).toBeLessThan(signingOrder);
  });

  it("stops at Persona when identity verification fails, without calling Plaid", async () => {
    mockEnv.PERSONA_API_KEY = "test-persona-key";
    mockEnv.PERSONA_KYC_TEMPLATE_ID = TEMPLATE_ID;
    vi.mocked(resolvePersonaKYC).mockResolvedValue({
      ok: false,
      error: "Persona KYC inquiry status: declined",
    });

    const result = await runIssuanceFlow(
      request({ credentialTypes: ["kyc", "funds"], personaInquiryId: INQUIRY_ID }),
      CTX,
    );

    expect(result.kind).toBe("error");
    expect(fetchPlaidBalance).not.toHaveBeenCalled();
  });
});
