// @vitest-environment node
//
// Coverage for GET /api/ready — the frontend's deep readiness probe.
//
// The route reads the validated env (lib/env.ts validates process.env at
// import time) and the contract configuration, so the module is re-imported
// per scenario with vi.resetModules() after the environment is prepared.
//
// The probe must:
//   - answer 200 only when every dependency check passes, 503 otherwise;
//   - report each dependency individually so an operator can see WHICH one is
//     broken, not just that something is;
//   - never be cached, so an intermediary cannot replay a stale verdict;
//   - carry the app version so a probe can identify the running build.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "NEXT_PUBLIC_APP_VERSION",
  "NEXT_PUBLIC_ISSUER_REGISTRY_ID",
  "NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID",
  "NEXT_PUBLIC_PROOF_REGISTRY_ID",
  "NEXT_PUBLIC_GATED_POOL_ID",
  "ISSUER_PRIVATE_KEY",
  "PERSONA_API_KEY",
  "PERSONA_KYC_TEMPLATE_ID",
] as const;

const savedEnv: Record<string, string | undefined> = {};

/** A 64-char hex key — the shape lib/env.ts accepts for ISSUER_PRIVATE_KEY. */
const VALID_ISSUER_KEY = "a".repeat(64);

/** Re-import the route so lib/env.ts re-validates the current process.env. */
async function loadRoute() {
  vi.resetModules();
  return import("../route");
}

function stubFetch(ok: boolean) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({}),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  delete process.env.ISSUER_PRIVATE_KEY;
  delete process.env.PERSONA_API_KEY;
  delete process.env.PERSONA_KYC_TEMPLATE_ID;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/ready", () => {
  it("answers 200 with every dependency healthy when fully configured", async () => {
    process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "C_ISSUER_REGISTRY";
    process.env.NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID = "C_CREDENTIAL_VERIFIER";
    process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID = "C_PROOF_REGISTRY";
    process.env.NEXT_PUBLIC_GATED_POOL_ID = "C_GATED_POOL";
    process.env.ISSUER_PRIVATE_KEY = VALID_ISSUER_KEY;
    process.env.PERSONA_API_KEY = "pk_test";
    process.env.PERSONA_KYC_TEMPLATE_ID = "itmpl_test";
    process.env.NEXT_PUBLIC_APP_VERSION = "1.2.3";
    stubFetch(true);

    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.signer).toMatchObject({ status: "ok", issuer: "configured" });
    expect(body.contracts).toMatchObject({ status: "ok" });
    expect(body.rpc).toMatchObject({ status: "ok" });
    expect(body.persona).toMatchObject({ status: "ok" });
    expect(body.app_version).toBe("1.2.3");
    expect(typeof body.deployment_timestamp).toBe("number");
    expect(body.contract_versions).toBeDefined();
  });

  it("answers 503 and names the failing dependency when the RPC is unreachable", async () => {
    process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "C_ISSUER_REGISTRY";
    process.env.NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID = "C_CREDENTIAL_VERIFIER";
    process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID = "C_PROOF_REGISTRY";
    process.env.NEXT_PUBLIC_GATED_POOL_ID = "C_GATED_POOL";
    process.env.ISSUER_PRIVATE_KEY = VALID_ISSUER_KEY;
    stubFetch(false);

    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.rpc.status).toBe("error");
    // The healthy dependencies are still reported, so the operator can tell
    // that the RPC is the only thing broken.
    expect(body.contracts.status).toBe("ok");
    expect(body.signer.status).toBe("ok");
  });

  it("answers 503 and lists the missing contract env vars when unconfigured", async () => {
    process.env.ISSUER_PRIVATE_KEY = VALID_ISSUER_KEY;
    stubFetch(true);

    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.contracts.status).toBe("error");
    expect(body.contracts.message).toContain("NEXT_PUBLIC_ISSUER_REGISTRY_ID");
    expect(body.contract_versions).toBeUndefined();
  });

  it("reports the demo signer when no issuer key is configured", async () => {
    process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "C_ISSUER_REGISTRY";
    process.env.NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID = "C_CREDENTIAL_VERIFIER";
    process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID = "C_PROOF_REGISTRY";
    process.env.NEXT_PUBLIC_GATED_POOL_ID = "C_GATED_POOL";
    stubFetch(true);

    const { GET } = await loadRoute();
    const res = await GET();

    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.signer).toMatchObject({ status: "error", issuer: "demo" });
  });

  it("falls back to app_version dev when the release pipeline did not stamp one", async () => {
    process.env.NEXT_PUBLIC_ISSUER_REGISTRY_ID = "C_ISSUER_REGISTRY";
    process.env.NEXT_PUBLIC_CREDENTIAL_VERIFIER_ID = "C_CREDENTIAL_VERIFIER";
    process.env.NEXT_PUBLIC_PROOF_REGISTRY_ID = "C_PROOF_REGISTRY";
    process.env.NEXT_PUBLIC_GATED_POOL_ID = "C_GATED_POOL";
    process.env.ISSUER_PRIVATE_KEY = VALID_ISSUER_KEY;
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    stubFetch(true);

    const { GET } = await loadRoute();
    const body = await (await GET()).json();

    expect(body.app_version).toBe("dev");
  });
});
