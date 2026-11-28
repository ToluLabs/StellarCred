"use client";

import { useState } from "react";
import { IconSwitchHorizontal, IconUser, IconCheck, IconChevronDown } from "@tabler/icons-react";
import { truncateAddress } from "@/lib/format";
import type { PortfolioAccount } from "@/lib/account-portfolio";

interface AccountPortfolioSwitcherProps {
  accounts: PortfolioAccount[];
  activeAddress: string | null;
  onSelectAccount: (address: string | null) => void;
  className?: string;
}

export function AccountPortfolioSwitcher({
  accounts,
  activeAddress,
  onSelectAccount,
  className = "",
}: AccountPortfolioSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (accounts.length <= 1 && !activeAddress) {
    return null;
  }

  const currentAccount = accounts.find(
    (a) => a.address.toLowerCase() === activeAddress?.toLowerCase(),
  );

  const displayLabel = currentAccount
    ? currentAccount.label || truncateAddress(currentAccount.address)
    : activeAddress
      ? truncateAddress(activeAddress)
      : "All Accounts";

  return (
    <div
      className={`relative inline-block text-left ${className}`}
      data-testid="account-portfolio-switcher"
    >
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="btn btn-secondary btn-sm flex items-center gap-1.5 font-mono text-xs"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Switch account portfolio"
      >
        <IconSwitchHorizontal size={14} className="opacity-70" aria-hidden="true" />
        <span>{displayLabel}</span>
        <IconChevronDown size={13} className="opacity-50" aria-hidden="true" />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} aria-hidden="true" />
          <div
            role="listbox"
            aria-label="Accounts"
            className="absolute left-0 mt-1 z-50 min-w-[200px] rounded-md border border-[var(--border)] bg-[var(--surface-elevated,#1e293b)] py-1 shadow-lg backdrop-blur-sm"
          >
            <button
              type="button"
              role="option"
              aria-selected={activeAddress === null || activeAddress === "all"}
              onClick={() => {
                onSelectAccount(null);
                setIsOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-xs text-left hover:bg-[var(--surface-hover,#334155)] transition-colors"
            >
              <div className="flex items-center gap-2">
                <IconUser size={13} className="opacity-60" />
                <span className="font-medium">All Accounts (Combined)</span>
              </div>
              {(!activeAddress || activeAddress === "all") && (
                <IconCheck size={13} className="text-primary-500 text-emerald-400" />
              )}
            </button>

            <div className="my-1 border-t border-[var(--border)] opacity-40" />

            {accounts.map((acc) => {
              const isSelected = acc.address.toLowerCase() === activeAddress?.toLowerCase();
              return (
                <button
                  key={acc.address}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onSelectAccount(acc.address);
                    setIsOpen(false);
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs text-left hover:bg-[var(--surface-hover,#334155)] transition-colors"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-slate-200">
                      {acc.label || "Connected Account"}
                    </span>
                    <span className="font-mono text-[10px] text-slate-400">
                      {truncateAddress(acc.address)}
                    </span>
                  </div>
                  {isSelected && (
                    <IconCheck size={13} className="text-primary-500 text-emerald-400" />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
