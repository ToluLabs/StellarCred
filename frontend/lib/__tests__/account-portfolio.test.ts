import { describe, it, expect, beforeEach } from "vitest";
import {
  getPortfolioAccounts,
  recordConnectedAccount,
  setAccountLabel,
  getActivePortfolioAccount,
  setActivePortfolioAccount,
  filterCredentialsByAccount,
} from "../account-portfolio";
import type { Credential } from "../credential";

const MOCK_ADDR_1 = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MOCK_ADDR_2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2";

describe("account-portfolio segregation (#1049)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("records new connected accounts and updates timestamps", () => {
    const accs1 = recordConnectedAccount(MOCK_ADDR_1, "Personal");
    expect(accs1).toHaveLength(1);
    expect(accs1[0].address).toBe(MOCK_ADDR_1);
    expect(accs1[0].label).toBe("Personal");
    expect(accs1[0].lastConnectedAt).toBeDefined();

    const accs2 = recordConnectedAccount(MOCK_ADDR_2, "Business");
    expect(accs2).toHaveLength(2);
    expect(getPortfolioAccounts()).toHaveLength(2);

    // Reconnecting updates timestamp without wiping label
    const accs3 = recordConnectedAccount(MOCK_ADDR_1);
    expect(accs3).toHaveLength(2);
    expect(accs3[0].label).toBe("Personal");
  });

  it("updates account labels", () => {
    recordConnectedAccount(MOCK_ADDR_1);
    setAccountLabel(MOCK_ADDR_1, "My Vault");
    const accounts = getPortfolioAccounts();
    expect(accounts[0].label).toBe("My Vault");
  });

  it("persists active account selection in local storage", () => {
    expect(getActivePortfolioAccount()).toBeNull();
    setActivePortfolioAccount(MOCK_ADDR_1);
    expect(getActivePortfolioAccount()).toBe(MOCK_ADDR_1);

    setActivePortfolioAccount(null);
    expect(getActivePortfolioAccount()).toBeNull();
  });

  it("segregates credentials by active account holder", () => {
    const creds: Partial<Credential>[] = [
      { commitment: "c1", holder: MOCK_ADDR_1, type: "kyc" },
      { commitment: "c2", holder: MOCK_ADDR_2, type: "age" },
      { commitment: "c3", holder: MOCK_ADDR_1, type: "income" },
    ];

    // Filter by account 1
    const filtered1 = filterCredentialsByAccount(creds as Credential[], MOCK_ADDR_1);
    expect(filtered1).toHaveLength(2);
    expect(filtered1.map((c) => c.commitment)).toEqual(["c1", "c3"]);

    // Filter by account 2
    const filtered2 = filterCredentialsByAccount(creds as Credential[], MOCK_ADDR_2);
    expect(filtered2).toHaveLength(1);
    expect(filtered2[0].commitment).toBe("c2");

    // All / null returns combined portfolio
    const all = filterCredentialsByAccount(creds as Credential[], null);
    expect(all).toHaveLength(3);

    const allString = filterCredentialsByAccount(creds as Credential[], "all");
    expect(allString).toHaveLength(3);
  });
});
