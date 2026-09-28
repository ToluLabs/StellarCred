// #620 — when several registered issuers can attest the claim a protocol asks
// for, the holder sees them, the protocol-accepted one is preselected, and
// picking an issuer outside the protocol's trusted list warns instead of
// silently issuing a proof that will be rejected.

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RegisteredIssuer } from "@/lib/issuer-registry";

const TEST_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const ISSUER_FOR_AGE_AND_KYC = `G${"B".repeat(55)}`;
const ISSUER_FOR_AGE_ONLY = `G${"C".repeat(55)}`;
const ISSUER_KYC_ONLY = `G${"D".repeat(55)}`;
// The protocol gate below accepts only ISSUER_FOR_AGE_ONLY.
const TRUSTED = ISSUER_FOR_AGE_ONLY;

const ISSUERS: RegisteredIssuer[] = [
  {
    id: ISSUER_FOR_AGE_AND_KYC,
    name: "Globule Registry",
    pubkeyHex: "aa".repeat(64),
    credentialTypes: ["age", "kyc"],
    revoked: false,
    metadata: { name: "Globule Registry", url: "https://globule.example" },
  },
  {
    id: ISSUER_FOR_AGE_ONLY,
    name: "Third Trust",
    pubkeyHex: "bb".repeat(64),
    credentialTypes: ["age"],
    revoked: false,
    metadata: { name: "Third Trust", url: "https://third.example" },
  },
  {
    id: ISSUER_KYC_ONLY,
    name: "Acme KYC",
    pubkeyHex: "cc".repeat(64),
    credentialTypes: ["kyc"],
    revoked: false,
    metadata: { name: "Acme KYC", url: "https://acme.example" },
  },
];

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () =>
    new URLSearchParams({
      return_url: "/callback",
      claim: "age",
      threshold_years: "21",
      trusted_issuers: TRUSTED,
    }),
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
  useToast: () => ({
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock("@/components/WalletButton", () => ({ WalletButton: () => null }));

// vitest deliberately leaves the contract IDs unset (lib/__tests__/config.test.ts
// asserts that), which disables the issue button as "app not configured". This
// test is about issuer choice, so pretend the deployment is configured.
vi.mock("@/lib/config", async (importOriginal: any) => {
  const actual = await importOriginal() as typeof import("@/lib/config");
  return { ...actual, issuanceConfigured: () => true };
});

vi.mock("@/lib/credential", async (importOriginal: any) => {
  const actual = await importOriginal() as typeof import("@/lib/credential");
  return { ...actual, saveCredential: vi.fn() };
});

import VerifyPage from "@/app/verify/page";

function mockJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Headers(),
  } as Response;
}

function issueBody(): Record<string, unknown> {
  const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
    ([url]) => url === "/api/issue",
  );
  expect(call).toBeDefined();
  return JSON.parse(call![1].body);
}

describe("holder picks the issuer (#620)", () => {
  beforeEach(() => {
    push.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) =>
        Promise.resolve(
          input === "/api/issuers"
            ? mockJsonResponse({ issuers: ISSUERS })
            : mockJsonResponse({ credentials: [] }),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the issuers that can attest the claim, preselects the protocol-accepted one", async () => {
    render(<VerifyPage />);

    // Both age-capable issuers are offered, with their on-chain metadata.
    const picker = await screen.findByRole("radiogroup", {
      name: /issuing authority/i,
    });
    expect(picker).toHaveTextContent(/Globule Registry/);
    expect(picker).toHaveTextContent(/Third Trust/);
    expect(picker).toHaveTextContent(/third\.example/);
    // Registered for kyc only, so it can't attest this claim.
    expect(picker).not.toHaveTextContent(/Acme KYC/);

    const checked = await waitFor(() => {
      const el = picker.querySelector('[aria-checked="true"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(checked).toHaveTextContent(/Third Trust/);
    expect(within(picker).getAllByText(/Accepted by protocol/i)).toHaveLength(1);
    expect(within(picker).getAllByText(/Not accepted/i)).toHaveLength(1);
    // The accepted pick needs no warning.
    expect(screen.queryByText(/trusted-issuer list/i)).toBeNull();
  });

  it("warns when the holder picks an issuer the protocol will not accept, and still issues from it", async () => {
    render(<VerifyPage />);

    const picker = await screen.findByRole("radiogroup", {
      name: /issuing authority/i,
    });
    fireEvent.click(within(picker).getByText(/Globule Registry/));

    await screen.findByText(/trusted-issuer list/i);
    expect(screen.getByText(/will reject a proof from it/i)).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: /get credential/i }),
    );
    // The registry read already used fetch, so wait for the issue POST itself.
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/issue",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(issueBody().issuerId).toBe(ISSUER_FOR_AGE_AND_KYC);
    expect(issueBody().issuerName).toBe("Globule Registry");
  });
});
