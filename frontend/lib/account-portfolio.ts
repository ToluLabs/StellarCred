/**
 * Multi-account portfolio management and credential segregation in localStorage.
 *
 * Provides:
 * - Tracking connected accounts (Stellar public keys)
 * - Assigning labels / nicknames (e.g. Personal vs Business)
 * - Segregating credentials by holder address so users can switch accounts
 *   and view filtered credential portfolios without clearing session data.
 */

import { STORAGE_KEYS } from "./storage-keys";
import { isStorageAvailable } from "./safe-storage";
import type { Credential } from "./credential";

export interface PortfolioAccount {
  address: string;
  label?: string;
  lastConnectedAt?: number;
}

/** Get list of saved portfolio accounts from storage. */
export function getPortfolioAccounts(): PortfolioAccount[] {
  if (!isStorageAvailable()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PORTFOLIO_ACCOUNTS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Save updated accounts list to storage. */
export function savePortfolioAccounts(accounts: PortfolioAccount[]): void {
  if (!isStorageAvailable()) return;
  try {
    localStorage.setItem(STORAGE_KEYS.PORTFOLIO_ACCOUNTS, JSON.stringify(accounts));
  } catch {
    // Ignore storage errors in private mode
  }
}

/** Record a connected account, updating its lastConnectedAt timestamp. */
export function recordConnectedAccount(address: string, defaultLabel?: string): PortfolioAccount[] {
  if (!address) return getPortfolioAccounts();
  const accounts = getPortfolioAccounts();
  const existingIndex = accounts.findIndex(
    (a) => a.address.toLowerCase() === address.toLowerCase(),
  );
  const now = Date.now();

  if (existingIndex >= 0) {
    accounts[existingIndex] = {
      ...accounts[existingIndex],
      lastConnectedAt: now,
      ...(defaultLabel && !accounts[existingIndex].label ? { label: defaultLabel } : {}),
    };
  } else {
    accounts.push({
      address,
      label: defaultLabel || `Account ${accounts.length + 1}`,
      lastConnectedAt: now,
    });
  }

  savePortfolioAccounts(accounts);
  return accounts;
}

/** Set custom label for an account in portfolio. */
export function setAccountLabel(address: string, label: string): PortfolioAccount[] {
  const accounts = getPortfolioAccounts();
  const account = accounts.find((a) => a.address.toLowerCase() === address.toLowerCase());
  if (account) {
    account.label = label.trim();
    savePortfolioAccounts(accounts);
  }
  return accounts;
}

/** Get the currently selected active portfolio address. */
export function getActivePortfolioAccount(): string | null {
  if (!isStorageAvailable()) return null;
  try {
    return localStorage.getItem(STORAGE_KEYS.ACTIVE_PORTFOLIO_ACCOUNT);
  } catch {
    return null;
  }
}

/** Set the active portfolio address. */
export function setActivePortfolioAccount(address: string | null): void {
  if (!isStorageAvailable()) return;
  try {
    if (address) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_PORTFOLIO_ACCOUNT, address);
    } else {
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_PORTFOLIO_ACCOUNT);
    }
  } catch {
    // Ignore storage errors in private mode
  }
}

/**
 * Filter credentials belonging to a specific holder address.
 * If targetAddress is "all" or empty, returns all credentials.
 * Handles case-insensitive comparison for Stellar addresses.
 */
export function filterCredentialsByAccount(
  credentials: Credential[],
  targetAddress?: string | null,
): Credential[] {
  if (!targetAddress || targetAddress === "all") {
    return credentials;
  }
  const normalized = targetAddress.toLowerCase().trim();
  return credentials.filter((cred) => {
    if (!cred.holder) return false;
    return cred.holder.toLowerCase().trim() === normalized;
  });
}
