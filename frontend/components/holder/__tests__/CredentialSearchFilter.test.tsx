/**
 * Tests for CredentialSearchFilter.
 *
 * Issue #902: Improve search and filtering for credential inventory
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Credential } from "@/lib/credential";
import { CredentialSearchFilter } from "../CredentialSearchFilter";

const router = { replace: vi.fn() };
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => router,
}));

function makeCred(overrides: Partial<Credential>): Credential {
  return {
    type: "kyc",
    title: "KYC credential",
    claim: "claim",
    issuer: "Issuer",
    issuerId: "GISSUER",
    holder: "GHOLDER",
    value: "1",
    salt: "salt",
    commitment: "commitment",
    sig: [],
    issuerPubX: [],
    issuerPubY: [],
    issuedAt: 1_700_000_000,
    expiry: "30 days",
    ...overrides,
  } as Credential;
}

const kyc = makeCred({ type: "kyc", title: "Passport check", commitment: "c-kyc", issuedAt: 100 });
const age = makeCred({ type: "age", title: "Over 18", commitment: "c-age", issuedAt: 300 });
const income = makeCred({ type: "income", title: "Salary", commitment: "c-income", issuedAt: 200 });
const all = [kyc, age, income];

/** The credentials passed to the most recent onFilteredChange call. */
function lastResult(onChange: ReturnType<typeof vi.fn>): Credential[] {
  return onChange.mock.calls[onChange.mock.calls.length - 1][0] as Credential[];
}

beforeEach(() => {
  router.replace.mockClear();
  window.localStorage?.removeItem?.("stellarcred:search-filter-state");
});

afterEach(() => {
  cleanup();
});

describe("CredentialSearchFilter", () => {
  it("reports every credential, newest first, before any filter is applied", () => {
    const onChange = vi.fn();
    render(<CredentialSearchFilter credentials={all} onFilteredChange={onChange} />);

    expect(lastResult(onChange).map((c) => c.commitment)).toEqual(["c-age", "c-income", "c-kyc"]);
  });

  it("filters by title text, case-insensitively", () => {
    const onChange = vi.fn();
    render(<CredentialSearchFilter credentials={all} onFilteredChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText(/search credentials/i), { target: { value: "SALARY" } });

    expect(lastResult(onChange).map((c) => c.commitment)).toEqual(["c-income"]);
  });

  it("filters by credential type", () => {
    const onChange = vi.fn();
    render(<CredentialSearchFilter credentials={all} onFilteredChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText(/search credentials/i), { target: { value: "age" } });

    expect(lastResult(onChange).map((c) => c.commitment)).toEqual(["c-age"]);
  });

  it("reports an empty list, not the full list, when nothing matches", () => {
    const onChange = vi.fn();
    render(<CredentialSearchFilter credentials={all} onFilteredChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText(/search credentials/i), { target: { value: "zzz-no-match" } });

    expect(lastResult(onChange)).toEqual([]);
  });

  it("filters by proof status using the facet checkboxes", () => {
    const proved = makeCred({ type: "kyc", title: "Proved one", commitment: "c-proved", provedAt: Math.floor(Date.now() / 1000) });
    const onChange = vi.fn();
    render(<CredentialSearchFilter credentials={[proved, age]} onFilteredChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /filters/i }));
    fireEvent.click(screen.getByLabelText(/^proved$/i));

    expect(lastResult(onChange).map((c) => c.commitment)).toEqual(["c-proved"]);
  });

  it("restores the full list after Clear all", () => {
    const onChange = vi.fn();
    render(<CredentialSearchFilter credentials={all} onFilteredChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText(/search credentials/i), { target: { value: "salary" } });
    expect(lastResult(onChange)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /clear all/i }));
    expect(lastResult(onChange)).toHaveLength(3);
  });

  it("mirrors the query into the URL", () => {
    render(<CredentialSearchFilter credentials={all} onFilteredChange={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText(/search credentials/i), { target: { value: "salary" } });

    expect(router.replace).toHaveBeenLastCalledWith("/holder?q=salary", { scroll: false });
  });
});
