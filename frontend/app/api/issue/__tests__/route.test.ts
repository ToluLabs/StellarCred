// @vitest-environment node
//
// Runs under the node environment, not the workspace-default jsdom: jsdom
// defines `window`, and @stellarcred/issuer refuses to load when `window`
// exists (its server-only guard — see packages/issuer/src/index.ts).
//
// Coverage for POST /api/issue (frontend/app/api/issue/route.ts) — the most
// security-sensitive route in the app: it signs commitments with the issuer
// key, relays Persona KYC, and calls Plaid.
//
// The module reads ISSUER_PRIVATE_KEY (and NEXT_PUBLIC_ISSUER_REGISTRY_ID) as
// module-scope constants at import time, so every test that needs a different
// value resets the module registry and re-imports fresh via loadRoute().

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import path from "path";
import os from "os";

const HOLDER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ISSUER_ID = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

function be32(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 255n);
    v >>= 8n;
  }
  return b;
}

vi.mock("@/lib/issuer-registry", () => ({
  fetchIssuerPubkey: vi.fn(),
}));

const ENV_KEYS = [
  "ISSUER_PRIVATE_KEY",
  "NEXT_PUBLIC_ISSUER_REGISTRY_ID",
  "NEXT_PUBLIC_ISSUER_ADDRESS",
  "PERSONA_API_KEY",
  "PERSONA_KYC_TEMPLATE_ID",
  "PLAID_ACCESS_TOKEN",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Re-imports the route module fresh so its module-scope constants (DEMO_SK_HEX,
// the IssuerClient instance) pick up whatever env vars are set beforehand.
async function loadRoute() {
  vi.resetModules();
  return import("../route");
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/issue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("mock-mode fallback (no ISSUER_PRIVATE_KEY)", () => {
  it("derives the demo issuer key deterministically from sha256(\"stellarcred-demo-issuer\")", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadRoute();

    const res = await POST(
      postRequest({ type: "kyc", holder: HOLDER, issuerId: ISSUER_ID }),
    );
    expect(res.status).toBe(200);
    const { credentials } = await res.json();

    const expectedSkHex = Buffer.from(
      sha256(new TextEncoder().encode("stellarcred-demo-issuer")),
    ).toString("hex");
    const expectedPub = secp256k1.getPublicKey(
      Uint8Array.from(Buffer.from(expectedSkHex, "hex")),
      false,
    );
    expect(credentials[0].issuerPubX).toEqual(Array.from(expectedPub.slice(1, 33)));
    expect(credentials[0].issuerPubY).toEqual(Array.from(expectedPub.slice(33, 65)));
  });
});

describe("signature correctness", () => {
  it("produces a signature secp256k1.verify accepts against the derived pubkey with prehash: false", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadRoute();

    const res = await POST(
      postRequest({ type: "kyc", holder: HOLDER, issuerId: ISSUER_ID }),
    );
    const { credentials } = await res.json();
    const credential = credentials[0];

    const pubkey = new Uint8Array([0x04, ...credential.issuerPubX, ...credential.issuerPubY]);
    const digest = be32(BigInt(credential.commitment));
    const sig = Uint8Array.from(credential.sig);

    expect(secp256k1.verify(sig, digest, pubkey, { prehash: false })).toBe(true);
  });
});

describe("validation", () => {
  it("rejects an unknown credential type", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadRoute();

    const res = await POST(
      postRequest({ credential_types: ["not-a-real-type"], holder: HOLDER, issuerId: ISSUER_ID }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid credential type/);
  });

  it("accepts the multi-claim shape (credential_types + attributes)", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadRoute();

    const res = await POST(
      postRequest({
        credential_types: ["age"],
        holder: HOLDER,
        issuerId: ISSUER_ID,
        attributes: { date_of_birth: "1995-06-15" },
      }),
    );
    expect(res.status).toBe(200);
    const { credentials } = await res.json();
    expect(credentials).toHaveLength(1);
    expect(credentials[0].type).toBe("age");
  });

  it("accepts the legacy single-type shape (type + attribute)", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadRoute();

    const res = await POST(
      postRequest({
        type: "age",
        attribute: "1995-06-15",
        holder: HOLDER,
        issuerId: ISSUER_ID,
      }),
    );
    expect(res.status).toBe(200);
    const { credentials } = await res.json();
    expect(credentials).toHaveLength(1);
    expect(credentials[0].type).toBe("age");
  });

  it("rejects a request with no credential type at all", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadRoute();

    const res = await POST(postRequest({ holder: HOLDER, issuerId: ISSUER_ID }));
    expect(res.status).toBe(400);
  });

  it("rejects a request missing the holder address", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const { POST } = await loadRoute();

    const res = await POST(postRequest({ type: "kyc", issuerId: ISSUER_ID }));
    expect(res.status).toBe(400);
  });
});

describe("no identity leakage", () => {
  it("never surfaces Persona's raw identity fields (first_name/last_name/id_number) in the response or logs", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    process.env.PERSONA_API_KEY = "test-persona-key";
    process.env.PERSONA_KYC_TEMPLATE_ID = "itmpl_test";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            id: "inq_test",
            attributes: {
              status: "approved",
              fields: {
                birthdate: { value: "1990-01-01" },
                "country-code": { value: "US" },
                "first-name": { value: "Alice" },
                "last-name": { value: "Example" },
                "id-number": { value: "123-45-6789" },
              },
            },
          },
        }),
      }),
    );

    const { POST } = await loadRoute();
    // Imported after loadRoute()'s vi.resetModules() so this resolves to the
    // same fresh logger instance route.ts itself just imported — spying
    // before the reset would watch a stale, disconnected instance and make
    // the "no PII in logs" assertions below pass vacuously.
    const { logger } = await import("@/lib/logger");
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    const errorSpy = vi.spyOn(logger, "error");

    const res = await POST(
      postRequest({
        type: "kyc",
        holder: HOLDER,
        issuerId: ISSUER_ID,
        persona_inquiry_id: "inq_test",
      }),
    );

    expect(res.status).toBe(200);
    const responseText = JSON.stringify(await res.json());
    expect(responseText).not.toMatch(/Alice|Example|123-45-6789/);
    expect(responseText).not.toMatch(/first_name|last_name|id_number/);

    expect(infoSpy.mock.calls.length).toBeGreaterThan(0);
    for (const spy of [infoSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        const logged = JSON.stringify(call);
        expect(logged).not.toMatch(/Alice|Example|123-45-6789/);
        expect(logged).not.toMatch(/first_name|last_name|id_number|first-name|last-name|id-number/);
      }
    }
  });
});

describe("issuance audit log (hash-chained, PII-free)", () => {
  // Each test points AUDIT_LOG_PATH at a throwaway file so the chain asserted
  // here is exactly what this test produced (the default path could carry
  // entries from earlier runs / other tests).
  afterEach(() => {
    delete process.env.AUDIT_LOG_PATH;
  });

  it("appends one PII-free, chained entry per issued commitment", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    process.env.AUDIT_LOG_PATH = path.join(
      os.tmpdir(),
      `stellarcred-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );

    const { POST } = await loadRoute();
    // Imported after loadRoute()'s vi.resetModules() so this resolves to the
    // same fresh audit-log module instance route.ts just imported.
    const { auditLogEntries, auditLogVerify, auditLogSize } = await import("@/lib/audit-log");

    const res = await POST(
      postRequest({ type: "kyc", holder: HOLDER, issuerId: ISSUER_ID }),
    );
    expect(res.status).toBe(200);
    const { credentials } = await res.json();
    expect(credentials).toHaveLength(1);

    expect(auditLogSize()).toBe(1);
    const [entry] = auditLogEntries();
    expect(entry.index).toBe(0);
    expect(entry.commitment).toBe(credentials[0].commitment);
    expect(entry.issuer).toBe(ISSUER_ID);
    expect(entry.timestamp).toBe(credentials[0].issuedAt);
    expect(entry.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(auditLogVerify().valid).toBe(true);

    // The audit entry itself carries no identity data.
    expect(JSON.stringify(entry)).not.toMatch(
      /holder|wallet|first_name|last_name|id_number|date_of_birth|value|salt/,
    );
  });

  it("chains successive issuances and persists a file a fresh verifier accepts", async () => {
    delete process.env.ISSUER_PRIVATE_KEY;
    const auditFile = path.join(
      os.tmpdir(),
      `stellarcred-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    process.env.AUDIT_LOG_PATH = auditFile;

    const { POST } = await loadRoute();
    const { auditLogEntries, auditLogVerify, readAuditLogFile, verifyAuditChain } =
      await import("@/lib/audit-log");

    const res1 = await POST(
      postRequest({ type: "kyc", holder: HOLDER, issuerId: ISSUER_ID }),
    );
    expect(res1.status).toBe(200);
    const res2 = await POST(
      postRequest({
        credential_types: ["age"],
        holder: HOLDER,
        issuerId: ISSUER_ID,
        attributes: { date_of_birth: "1995-06-15" },
      }),
    );
    expect(res2.status).toBe(200);

    const entries = auditLogEntries();
    expect(entries).toHaveLength(2);
    expect(entries[1].index).toBe(1);
    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(entries[1].hash).not.toBe(entries[0].hash);
    expect(auditLogVerify().valid).toBe(true);

    // The persisted file must be accepted by an independent verifier reading
    // from disk — i.e. `pnpm verify:audit-log` semantics.
    const reloaded = await readAuditLogFile(auditFile);
    expect(reloaded).toHaveLength(2);
    expect(reloaded).toEqual(entries);
    expect(verifyAuditChain(reloaded).valid).toBe(true);
  });
});

describe("issuer-key mismatch", () => {
  it("rejects when ISSUER_PRIVATE_KEY's pubkey doesn't match the registered issuer", async () => {
    delete process.env.ISSUER_PRIVATE_KEY; // demo key
    process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "CREGISTRYCONTRACTIDTESTTESTTESTTESTTEST";

    const { fetchIssuerPubkey } = await import("@/lib/issuer-registry");
    // A pubkey that cannot possibly match the demo-derived key.
    vi.mocked(fetchIssuerPubkey).mockResolvedValue(new Uint8Array(64).fill(0xff));

    const { POST } = await loadRoute();
    const res = await POST(
      postRequest({ type: "kyc", holder: HOLDER, issuerId: ISSUER_ID }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/does not match/);
  });

  it("succeeds when the registered pubkey matches the signing key", async () => {
    delete process.env.ISSUER_PRIVATE_KEY; // demo key
    process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "CREGISTRYCONTRACTIDTESTTESTTESTTESTTEST";

    const expectedSkHex = Buffer.from(
      sha256(new TextEncoder().encode("stellarcred-demo-issuer")),
    ).toString("hex");
    const expectedPub = secp256k1.getPublicKey(
      Uint8Array.from(Buffer.from(expectedSkHex, "hex")),
      false,
    );
    const matchingPubkeyBytes = expectedPub.slice(1, 65); // x || y, 64 bytes

    const { fetchIssuerPubkey } = await import("@/lib/issuer-registry");
    vi.mocked(fetchIssuerPubkey).mockResolvedValue(matchingPubkeyBytes);

    const { POST } = await loadRoute();
    const res = await POST(
      postRequest({ type: "kyc", holder: HOLDER, issuerId: ISSUER_ID }),
    );

    expect(res.status).toBe(200);
  });
});
