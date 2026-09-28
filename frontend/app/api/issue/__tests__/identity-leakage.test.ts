// @vitest-environment node
//
// Flow-level privacy gate for credential issuance (issue #627).
//
// The unit tests elsewhere prove individual components are careful —
// `stripSensitiveFields` has an allowlist, the audit log stores only
// commitments, `redactPayload` gates the error-reporting payload, and
// `registerPendingInquiry` persists a whitelist. None of them prove the
// *property* the security model actually claims:
//
//   identity fields (first_name, last_name, id_number) are never retained
//   after the KYC provider call.
//
// That property is about the whole issuance flow, so this test asserts it end
// to end. It runs a real issuance with recognisable sentinel identity values
// and then proves the sentinels reach NONE of the places the flow writes to:
//
//   1. the structured log stream (every pino level, every argument)
//   2. the on-disk audit log file
//   3. the error-reporting webhook payload
//   4. the idempotency cache (which caches a serialized response body)
//   5. the persisted Persona context — the server-side pending-inquiry record
//      AND the client-side sessionStorage resume blob
//   6. the HTTP response body
//
// Every assertion runs on the success path and on failures injected at each
// stage of the flow, because a mid-flight failure is when data is most likely
// to leak: error paths are the ones that tend to widen what gets logged,
// reported, cached, or returned.
//
// Node environment (not the jsdom default) because @stellarcred/issuer refuses
// to load when `window` exists — same reason as route.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, rmSync } from "fs";
import path from "path";
import os from "os";

const HOLDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ISSUER_ID = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";
const INQUIRY_ID = "inq_sentinel_0001";
const ERROR_WEBHOOK = "https://webhook.example.com/stellarcred-errors";

// Recognisable, deliberately unrealistic identity values. If any of these
// strings turns up in any sink, the flow persisted identity data and the gate
// fails. They are alphabetic and not date-shaped on purpose:
// `safeErrorMessage` only redacts emails, YYYY-MM-DD, and runs of 6+ digits,
// so this gate cannot pass merely because a value happened to look
// redactable.
const SENTINELS = {
  firstName: "Sentinelfirstname",
  lastName: "Sentinellastname",
  idNumber: "Sentinelidnumber",
  birthdate: "2888-07-07",
} as const;

const SENTINEL_VALUES = Object.values(SENTINELS);

// Field names as they appear anywhere in the flow — Persona's hyphenated wire
// names, the snake_case names used by the allowlists, and the JSON keys a
// future change might log alongside a value. None may appear at all.
const IDENTITY_FIELD_NAMES = [
  "first_name",
  "last_name",
  "id_number",
  "first-name",
  "last-name",
  "id-number",
  "date_of_birth",
  "birthdate",
];

// ── Persona wire payload carrying the sentinels ─────────────────────────────
function personaFields() {
  return {
    birthdate: { value: SENTINELS.birthdate },
    "selected-country-code": { value: "NG" },
    "first-name": { value: SENTINELS.firstName },
    "last-name": { value: SENTINELS.lastName },
    "id-number": { value: SENTINELS.idNumber },
  };
}

function personaApprovedResponse() {
  return {
    ok: true,
    json: async () => ({
      data: {
        id: INQUIRY_ID,
        attributes: { status: "approved", fields: personaFields() },
      },
    }),
  };
}

vi.mock("@/lib/issuer-registry", () => ({
  fetchIssuerPubkey: vi.fn(),
}));

const ENV_KEYS = [
  "ISSUER_PRIVATE_KEY",
  "NEXT_PUBLIC_ISSUER_REGISTRY_ID",
  "PERSONA_API_KEY",
  "PERSONA_KYC_TEMPLATE_ID",
  "ERROR_REPORTING_WEBHOOK",
  "AUDIT_LOG_PATH",
] as const;

const savedEnv: Record<string, string | undefined> = {};

// Every fetch body that went to the error-reporting webhook during the flow.
let errorReportBodies: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  errorReportBodies = [];

  delete process.env.ISSUER_PRIVATE_KEY; // deterministic demo issuer key
  delete process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID;
  process.env.PERSONA_API_KEY = "test-persona-key";
  process.env.PERSONA_KYC_TEMPLATE_ID = "itmpl_sentinel";
  process.env.ERROR_REPORTING_WEBHOOK = ERROR_WEBHOOK;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Flow harness ────────────────────────────────────────────────────────────

/**
 * Minimal in-memory sessionStorage so the client-side Persona resume blob
 * (lib/persona-pending.ts, normally browser-only) can be exercised from this
 * node-environment flow. The test then inspects the *serialized* blob, which
 * is what actually reaches browser storage.
 */
function installSessionStorageShim(): void {
  const map = new Map<string, string>();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as unknown as Storage;
}

function sessionStorageDump(): string {
  const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  if (!storage) return "";
  const out: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key) out.push(`${key}=${storage.getItem(key)}`);
  }
  return out.join("\n");
}

interface FlowOptions {
  /** Persona response for the inquiry-resume stage. */
  persona?: () => Promise<unknown>;
  /** Persona response for the inquiry-creation stage. */
  personaCreate?: () => Promise<unknown>;
  /** Inject a failure at the signing stage. */
  signingFailure?: () => Error;
  auditLogPath: string;
}

interface Flow {
  post: (body: unknown, idempotencyKey?: string) => Promise<Response>;
  /** Every sink the flow can write to, as text. */
  sinks: () => Promise<Record<string, string>>;
}

/**
 * Boots a fresh copy of the issuance route — so module-scope env reads and the
 * logger / audit-log / idempotency / Persona module instances all belong to
 * this run — and returns a `post` helper plus a `sinks()` reader.
 */
async function startFlow(opts: FlowOptions): Promise<Flow> {
  vi.resetModules();
  process.env.AUDIT_LOG_PATH = opts.auditLogPath;

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(ERROR_WEBHOOK)) {
      if (init?.body) errorReportBodies.push(String(init.body));
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes("/inquiries/")) {
      return opts.persona ? await opts.persona() : personaApprovedResponse();
    }
    if (url.endsWith("/inquiries")) {
      return (
        (opts.personaCreate && (await opts.personaCreate())) ?? {
          ok: true,
          json: async () => ({ data: { id: INQUIRY_ID } }),
        }
      );
    }
    throw new Error(`unexpected outbound request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  installSessionStorageShim();

  const { POST } = await import("../route");
  const { logger } = await import("@/lib/logger");
  const { idempotencyGet } = await import("@/lib/idempotency");
  const { getPendingInquiry, getInquiryResult } = await import(
    "@/lib/persona-webhook"
  );
  const { savePersonaPending, PERSONA_PENDING_KEY } = await import(
    "@/lib/persona-pending"
  );
  const { IssuerClient } = await import("@stellarcred/issuer");

  // Every id the flow was asked to cache under, so the sink reader can dump
  // each entry rather than only the most recent one.
  const cacheKeys: string[] = [];

  // Capture every level, not just the ones this route happens to use today:
  // the point of the gate is to fail when a *new* logging path appears.
  const logged: string[] = [];
  for (const level of [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
  ] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(safeStringify).join(" "));
    });
  }

  if (opts.signingFailure) {
    const failure = opts.signingFailure;
    vi.spyOn(IssuerClient.prototype, "issue").mockImplementation(() => {
      throw failure();
    });
  }

  return {
    post: (body: unknown, idempotencyKey?: string) => {
      if (idempotencyKey) cacheKeys.push(idempotencyKey);
      return POST(
        new NextRequest("http://localhost/api/issue", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    },

    sinks: async () => {
      // reportError is fired without await inside the route
      // (`void reportError(...)`), so give its webhook POST time to land.
      await flushAsync();

      // The browser-side half of the Persona round-trip: whatever the tab
      // stashes for resume, with the same identity values in hand. A hostile
      // or buggy caller can round-trip identity data through claimParams, so
      // persona-pending.ts must drop it at every depth before serializing.
      savePersonaPending({
        credential_types: ["kyc"],
        holder: HOLDER,
        issuerId: ISSUER_ID,
        issuerName: "StellarCred Authority",
        expiry: "90 days",
        claimParams: {
          first_name: SENTINELS.firstName,
          last_name: SENTINELS.lastName,
          id_number: SENTINELS.idNumber,
          nested: { attributes: { first_name: SENTINELS.firstName } },
        },
      } as never);

      return {
        "log stream": logged.join("\n"),
        "audit log file": safeReadFile(opts.auditLogPath),
        "error report sink": errorReportBodies.join("\n"),
        "idempotency cache": JSON.stringify(
          cacheKeys.map((key) => [key, idempotencyGet(key)]),
        ),
        "persona pending context (server)": JSON.stringify({
          pending: getPendingInquiry(INQUIRY_ID),
          result: getInquiryResult(INQUIRY_ID),
        }),
        [`persona pending context (client, ${PERSONA_PENDING_KEY})`]:
          sessionStorageDump(),
      };
    },
  };
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** Let queued microtasks/timers (the fire-and-forget error report) settle. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let auditCounter = 0;
function tempAuditPath(): string {
  auditCounter += 1;
  return path.join(
    os.tmpdir(),
    `stellarcred-identity-leak-${Date.now()}-${auditCounter}.jsonl`,
  );
}

/**
 * The gate: for every sink the flow can write to, no sentinel value and no
 * identity field name may appear. Failing assertions name the sink, so a
 * report says *where* the leak is rather than only that there is one.
 */
function expectNoIdentityLeak(sinks: Record<string, string>): void {
  for (const [name, text] of Object.entries(sinks)) {
    for (const value of SENTINEL_VALUES) {
      expect(
        text,
        `${name} must not contain the sentinel value "${value}"`,
      ).not.toContain(value);
    }
    for (const field of IDENTITY_FIELD_NAMES) {
      expect(
        text,
        `${name} must not mention the identity field "${field}"`,
      ).not.toContain(field);
    }
  }
}

// ── The gate ────────────────────────────────────────────────────────────────

describe("identity fields never reach storage or logs during issuance (#627)", () => {
  it("keeps sentinels out of every sink across the whole success path", async () => {
    const auditFile = tempAuditPath();
    const flow = await startFlow({ auditLogPath: auditFile });

    try {
      // ── Phase 1: issue request before KYC → Persona redirect (202). This is
      //    the stage that persists the server-side pending-inquiry context, so
      //    it is the first place identity data could survive the round-trip.
      const created = await flow.post(
        {
          credential_types: ["kyc"],
          holder: HOLDER,
          issuerId: ISSUER_ID,
          claimParams: { first_name: SENTINELS.firstName },
        },
        "sentinel-idem-create",
      );
      expect(created.status).toBe(202);
      const createdText = JSON.stringify(await created.json());
      expect(createdText).toContain("needsPersona");

      expectNoIdentityLeak({ ...(await flow.sinks()), "response body": createdText });

      // ── Phase 2: the holder returns from Persona and issuance resumes. The
      //    provider now hands back the sentinel identity fields; they are used
      //    to derive claims and must not outlive the request.
      const issued = await flow.post(
        {
          credential_types: ["kyc", "age"],
          holder: HOLDER,
          issuerId: ISSUER_ID,
          persona_inquiry_id: INQUIRY_ID,
          // A client must not be able to smuggle identity data in through
          // `attributes` into anything the flow persists or returns either.
          attributes: {
            first_name: SENTINELS.firstName,
            last_name: SENTINELS.lastName,
            id_number: SENTINELS.idNumber,
          },
        },
        "sentinel-idem-issue",
      );
      expect(issued.status).toBe(200);

      // The response carries commitments, signatures, and the circuit
      // preimage (value/salt) the holder needs to build a witness — see
      // ADR-003 holder-authorized submission — but never the identity strings.
      const issuedText = JSON.stringify(await issued.json());
      expect(issuedText).toContain("commitment");

      const sinks = await flow.sinks();
      expectNoIdentityLeak({ ...sinks, "response body": issuedText });

      // The happy path must still have produced real audit, cache, and log
      // output; otherwise the assertions above would pass vacuously.
      expect(sinks["audit log file"]).toContain("commitment");
      expect(sinks["idempotency cache"]).toContain("commitment");
      expect(sinks["log stream"]).toContain("signing_success");
    } finally {
      rmSync(auditFile, { force: true });
    }
  });

  it("keeps sentinels out of the idempotent replay served from the cache", async () => {
    const auditFile = tempAuditPath();
    const flow = await startFlow({ auditLogPath: auditFile });
    const key = "sentinel-idem-replay";

    try {
      const body = {
        credential_types: ["kyc"],
        holder: HOLDER,
        issuerId: ISSUER_ID,
        persona_inquiry_id: INQUIRY_ID,
        attributes: { id_number: SENTINELS.idNumber },
      };

      const first = await flow.post(body, key);
      expect(first.status).toBe(200);
      await first.text(); // drain, so sendResponse caches the body

      // Same key again: served entirely from the serialized cache entry, with
      // no provider call and no signing at all.
      const replay = await flow.post(body, key);
      expect(replay.status).toBe(200);
      expect(replay.headers.get("X-Idempotent")).toBe("true");
      const replayText = await replay.text();

      const sinks = await flow.sinks();
      expect(sinks["idempotency cache"]).toContain("commitment");
      expectNoIdentityLeak({ ...sinks, "response body (replay)": replayText });
    } finally {
      rmSync(auditFile, { force: true });
    }
  });

  // ── Failures injected at each stage ───────────────────────────────────────
  // A mid-flight failure is when data is most likely to leak: error paths are
  // where handlers widen what they log, report, cache, or return.

  it("keeps sentinels out of every sink when the KYC provider declines", async () => {
    const auditFile = tempAuditPath();
    const flow = await startFlow({
      auditLogPath: auditFile,
      persona: async () => ({
        ok: true,
        json: async () => ({
          data: {
            id: INQUIRY_ID,
            attributes: { status: "declined", fields: personaFields() },
          },
        }),
      }),
    });

    try {
      const res = await flow.post(
        {
          credential_types: ["kyc"],
          holder: HOLDER,
          issuerId: ISSUER_ID,
          persona_inquiry_id: INQUIRY_ID,
        },
        "sentinel-idem-declined",
      );
      expect(res.status).toBe(403);

      const sinks = await flow.sinks();
      expect(sinks["log stream"]).toContain("verification_failed");
      expect(sinks["idempotency cache"]).toContain("403");
      expectNoIdentityLeak({ ...sinks, "response body": await res.text() });
    } finally {
      rmSync(auditFile, { force: true });
    }
  });

  it("keeps sentinels out of every sink when the KYC provider fails and echoes the inquiry back", async () => {
    const auditFile = tempAuditPath();
    const flow = await startFlow({
      auditLogPath: auditFile,
      // Realistic worst case: the provider's error body echoes the fields it
      // holds, and lib/persona.ts puts that JSON into the thrown Error's
      // message. The flow must not surface that message to any sink.
      persona: async () => ({
        ok: false,
        json: async () => ({
          errors: [
            {
              code: "inquiry_invalid",
              message: `Inquiry rejected for ${SENTINELS.firstName} ${SENTINELS.lastName} (${SENTINELS.idNumber}, born ${SENTINELS.birthdate})`,
            },
          ],
        }),
      }),
    });

    try {
      const res = await flow.post(
        {
          credential_types: ["kyc"],
          holder: HOLDER,
          issuerId: ISSUER_ID,
          persona_inquiry_id: INQUIRY_ID,
        },
        "sentinel-idem-provider-error",
      );

      const sinks = await flow.sinks();
      expectNoIdentityLeak({ ...sinks, "response body": await res.text() });
    } finally {
      rmSync(auditFile, { force: true });
    }
  });

  it("keeps sentinels out of every sink when signing fails mid-issuance", async () => {
    const auditFile = tempAuditPath();
    const flow = await startFlow({
      auditLogPath: auditFile,
      signingFailure: () =>
        // Raised after the provider returned the sentinels, so the handler is
        // holding identity data at the moment it errors out.
        new Error("commitment computation rejected for the pending inquiry"),
    });

    try {
      const res = await flow.post(
        {
          credential_types: ["kyc"],
          holder: HOLDER,
          issuerId: ISSUER_ID,
          persona_inquiry_id: INQUIRY_ID,
          attributes: {
            first_name: SENTINELS.firstName,
            id_number: SENTINELS.idNumber,
          },
        },
        "sentinel-idem-signing-failure",
      );
      expect(res.status).toBe(500);

      const sinks = await flow.sinks();
      // Both error sinks are expected to be exercised on this path; if either
      // stopped being written, the assertions below would be checking less
      // than they claim.
      expect(sinks["log stream"]).toContain("signing_failed");
      expect(sinks["error report sink"]).toContain("/api/issue");

      expectNoIdentityLeak({ ...sinks, "response body": await res.text() });
    } finally {
      rmSync(auditFile, { force: true });
    }
  });
});
