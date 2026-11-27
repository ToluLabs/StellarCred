"use client";

import { useState } from "react";
import { PREVIEW_CREDENTIALS } from "@/lib/preview-fixtures";
import type { Credential } from "@/lib/credential";
import {
  getPortfolioAccounts,
  recordConnectedAccount,
  getActivePortfolioAccount,
  setActivePortfolioAccount,
  filterCredentialsByAccount,
  type PortfolioAccount,
} from "@/lib/account-portfolio";

/**
 * Manages multi-account portfolio selection and filters holder credentials
 * for the active portfolio account (or preview fixtures in preview mode).
 */
export function usePortfolioFilter(
  creds: Credential[],
  isPreview: boolean,
  address: string | null,
) {
  const [accounts, setAccounts] = useState<PortfolioAccount[]>(() => getPortfolioAccounts());
  const [activeAddress, setActiveAddress] = useState<string | null>(() =>
    getActivePortfolioAccount(),
  );

  // Update known accounts when connected address changes
  useState(() => {
    if (address) {
      setAccounts(recordConnectedAccount(address));
    }
  });

  const selectAccount = (selectedAddr: string | null) => {
    setActiveAddress(selectedAddr);
    setActivePortfolioAccount(selectedAddr);
  };

  const rawCreds = isPreview ? PREVIEW_CREDENTIALS : creds;
  const displayCreds = filterCredentialsByAccount(rawCreds, activeAddress);

  return {
    accounts,
    activeAddress,
    selectAccount,
    displayCreds,
  };
}
