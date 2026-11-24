"use client";

import { StellarNetwork, NETWORK_PRESETS } from "./stellar";

const PREF_KEY = "stellarcred_preferred_network";

export function getPreferredNetwork(): StellarNetwork {
  if (typeof window === "undefined") return "testnet";
  const stored = localStorage.getItem(PREF_KEY);
  if (stored && stored in NETWORK_PRESETS) {
    return stored as StellarNetwork;
  }
  return "testnet";
}

export function setPreferredNetwork(network: StellarNetwork): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(PREF_KEY, network);
}
