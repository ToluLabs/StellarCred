"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  filterCredentialsByAccount,
  getActivePortfolioAccount,
  getPortfolioAccounts,
  recordConnectedAccount,
  setActivePortfolioAccount,
  type PortfolioAccount,
} from "@/lib/account-portfolio";
import type { Credential } from "@/lib/credential";

/** Keep portfolio persistence and credential filtering out of the holder page shell. */
export function useAccountPortfolio(address: string | null, credentials: Credential[]) {
  const [portfolioAccounts, setPortfolioAccounts] = useState<PortfolioAccount[]>(() =>
    getPortfolioAccounts(),
  );
  const [activeAccountFilter, setActiveAccountFilter] = useState<string | null>(() =>
    getActivePortfolioAccount(),
  );

  useEffect(() => {
    if (!address) return;

    const accounts = recordConnectedAccount(address);
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setPortfolioAccounts(accounts);
    });

    return () => {
      cancelled = true;
    };
  }, [address]);

  const handleSelectPortfolioAccount = useCallback((selectedAddress: string | null) => {
    setActiveAccountFilter(selectedAddress);
    setActivePortfolioAccount(selectedAddress);
  }, []);

  const displayCreds = useMemo(
    () => filterCredentialsByAccount(credentials, activeAccountFilter),
    [activeAccountFilter, credentials],
  );

  return {
    portfolioAccounts,
    activeAccountFilter,
    displayCreds,
    handleSelectPortfolioAccount,
  };
}
