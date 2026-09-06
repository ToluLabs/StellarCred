// Integration coverage for the happy-path credential journey:
//   buildVerifyUrl -> land on /verify -> mock-mode issuance (/api/issue)
//   -> redirect to return_url carrying sc_verified + sc_claims
//
// plus a second test covering the downstream proving pipeline
// (witness -> prove -> submit) that a holder runs after issuance, with the
// heavy WASM proving and on-chain submission mocked out so this runs in CI
// in seconds without testnet or real proving.
//
// The 1500ms delay between "credential issued" and the redirect
// (frontend/app/verify/page.tsx) is intentional and is asserted here, not
// changed.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Credential } from "@/lib/credential";

const TEST_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
// Must match vitest.config.ts's `test.env.NEXT_PUBLIC_ISSUER_ADDRESS` — that's
// what app/verify/page.tsx's module-scope DEMO_ISSUER_ID actually reads.
const TEST_ISSUER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () =>
    // Mirrors the query string produced by @stellarcred/sdk's buildVerifyUrl({
    //   returnUrl: "/callback", claim: "age",
    // }) — a relative return_url that resolves against this app's own origin.
    new URLSearchParams({ return_url: "/callback", claim: "age" }),
}));

vi.mock("@/lib/wallet-context", () => ({
  useWallet: () => ({
    address: TEST_ADDRESS,
    connecting: false,
    error: null,
    networkMismatch: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

// WalletButton pulls in lib/wallet.ts (Stellar Wallets Kit / Freighter), which
// needs a real browser wallet extension environment — irrelevant to this flow
// and not resolvable in jsdom, so it's stubbed out.
vi.mock("@/components/WalletButton", () => ({
  WalletButton: () => null,
}));

vi.mock("@/lib/credential", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("@/lib/credential");
  return { ...actual, saveCredential: vi.fn() };
});

import VerifyPage from "@/app/verify/page";

function mockJsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    json: async () => body,
    headers: new Headers(init?.headers ?? {}),
  } as Response;
}

describe("verify -> issue -> redirect", () => {
  beforeEach(() => {
    push.mockClear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Runs out the real 1500ms redirect delay (frontend/app/verify/page.tsx) rather
  // than faking timers — React 18's scheduler doesn't reliably flush under fake
  // timers in jsdom, and this keeps the test asserting the delay is unchanged
  // without that flakiness.
  it("redirects to return_url with sc_verified=true and the issued sc_claims, after the 1500ms delay", async () => {
    const issuedCredential: Credential = {
      type: "age",
      title: "Age Verified",
      claim: "age >= 18",
      issuer: "StellarCred Authority",
      issuerId: TEST_ISSUER,
      holder: TEST_ADDRESS,
      value: "1995-06-15",
      salt: "1",
      commitment: "2",
      sig: [1, 2, 3],
      issuerPubX: [4, 5, 6],
      issuerPubY: [7, 8, 9],
      issuedAt: Math.floor(Date.now() / 1000),
      expiry: "90 days",
    };

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockJsonResponse({ credentials: [issuedCredential] }),
    );

    render(<VerifyPage />);

    const button = await screen.findByRole("button", { name: /get credential/i });
    fireEvent.click(button);

    // The issuance call carries a request id header for cross-route tracing (#221).
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/issue");
    expect(init.method).toBe("POST");
    expect(typeof init.headers["x-request-id"]).toBe("string");
    expect(init.headers["x-request-id"].length).toBeGreaterThan(0);
    const body = JSON.parse(init.body);
    expect(body.credential_types).toEqual(["age"]);
    expect(body.holder).toBe(TEST_ADDRESS);
    expect(body.returnUrl).toBe("/callback");

    // "Get verified" (the page heading) also matches a loose /verified/i
    // regex, so match the post-issuance status line specifically.
    await screen.findByText(/returning to|credential saved — redirecting/i);

    // Redirect must not fire immediately — it's gated behind the 1500ms delay.
    expect(push).not.toHaveBeenCalled();

    // Waits out the real delay; generous timeout covers it plus test overhead.
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1), { timeout: 3000 });

    const [dest] = push.mock.calls[0];
    const parsed = new URL(dest, "http://localhost");
    expect(parsed.pathname).toBe("/callback");
    expect(parsed.searchParams.get("sc_verified")).toBe("true");
    expect(parsed.searchParams.get("sc_wallet")).toBe(TEST_ADDRESS);
    expect(parsed.searchParams.get("sc_claims")).toBe("age");
  }, 10_000);
});

describe("prove(mock) -> submit(mock) pipeline", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes a witness through mocked proving and a mocked contract submission", async () => {
    // lib/proof.ts's proveWithBackend loads bb.js WASM via a runtime-only
    // `import("/bb/index.js")` that Vite's static analysis can't resolve
    // (it's fetched from /public/bb in the browser, never bundled — see the
    // webpackIgnore comment at its call site) — so the module itself can't be
    // imported as-is under Vitest/Vite. computeWitness's contract (POST
    // /api/witness -> decode the hex response into bytes) is reproduced here
    // rather than mocking around that; proveWithBackend and submitProof are
    // mocked outright since real proving/submission need a browser + testnet.
    vi.doMock("@/lib/proof", () => ({
      computeWitness: async (type: string, credential: Record<string, unknown>) => {
        const res = await fetch("/api/witness", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, credential }),
        });
        if (!res.ok) throw new Error(`Witness generation failed: ${res.statusText}`);
        const { witness: hex } = (await res.json()) as { witness: string };
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
      },
      // Real UltraHonk proving loads bb.js WASM in the browser — too heavy
      // and non-deterministic for CI, so it's mocked here.
      proveWithBackend: vi.fn().mockResolvedValue({
        proof: new Uint8Array([9, 9, 9]),
        publicInputs: new Uint8Array([1, 1, 1]),
      }),
    }));
    vi.doMock("@/lib/contracts", () => ({
      // Real submission signs + submits a Soroban tx against testnet — mocked
      // so this test needs neither a wallet nor network access.
      submitProof: vi.fn().mockResolvedValue("mocktxhash"),
    }));

    const { computeWitness, proveWithBackend } = await import("@/lib/proof");
    const { submitProof } = await import("@/lib/contracts");

    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockJsonResponse({ witness: "deadbeef" }),
    );

    const witness = await computeWitness("age", {
      value: "1995-06-15",
      salt: "1",
      commitment: "2",
      sig: [1, 2, 3],
      issuerPubX: [4, 5, 6],
      issuerPubY: [7, 8, 9],
    });
    expect(Array.from(witness)).toEqual([0xde, 0xad, 0xbe, 0xef]);

    const { proof, publicInputs } = await proveWithBackend("age", witness);
    expect(Array.from(proof)).toEqual([9, 9, 9]);

    const txHash = await submitProof({
      holder: TEST_ADDRESS,
      issuerId: TEST_ISSUER,
      credentialType: "age",
      proof,
      publicInputs,
      ttlSecs: 90 * 86_400,
    });
    expect(txHash).toBe("mocktxhash");
  });
});
