"use client";

import { useState, useEffect, useCallback } from "react";
import { isStorageAvailable } from "./safe-storage";

const STORAGE_KEY = "stellarcred:onboarding";
const RESET_EVENT = "stellarcred:onboarding:reset";
const LEGACY_STORAGE_KEY = "stellarcred_onboarding_seen";

export type OnboardingStep =
  | "welcome"
  | "connect-wallet"
  | "get-credential"
  | "generate-proof"
  | "unlock";

export const ONBOARDING_STEPS: OnboardingStep[] = [
  "welcome",
  "connect-wallet",
  "get-credential",
  "generate-proof",
  "unlock",
];

export interface OnboardingState {
  step: number;
  dismissed: boolean;
  completed: boolean;
}

const DEFAULT_STATE: OnboardingState = {
  step: 0,
  dismissed: false,
  completed: false,
};

function loadState(): OnboardingState {
  if (!isStorageAvailable()) return DEFAULT_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy === "1") {
        return { ...DEFAULT_STATE, dismissed: true };
      }
      return DEFAULT_STATE;
    }
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return {
      step: typeof parsed.step === "number" ? parsed.step : 0,
      dismissed: parsed.dismissed === true,
      completed: parsed.completed === true,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function saveState(state: OnboardingState): void {
  if (!isStorageAvailable()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable — silently fail
  }
}

export function shouldShowOnboarding(): boolean {
  const state = loadState();
  return !state.dismissed && !state.completed;
}

export function resetOnboarding(): void {
  saveState(DEFAULT_STATE);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(RESET_EVENT));
  }
}

// Legacy API for OnboardingTour component
export function hasSeenTour(): boolean {
  if (typeof window === "undefined") return true;
  try {
    if (localStorage.getItem(STORAGE_KEY)) {
      const state = loadState();
      return state.dismissed || state.completed;
    }
    return localStorage.getItem(LEGACY_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(LEGACY_STORAGE_KEY, "1");
    saveState({ ...DEFAULT_STATE, dismissed: true });
  } catch {
    // Silently fail
  }
}

export function resetTour(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    resetOnboarding();
  } catch {
    // Silently fail
  }
}

export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setState(loadState());
    setMounted(true);

    function onReset() {
      setState(loadState());
    }
    window.addEventListener(RESET_EVENT, onReset);
    return () => window.removeEventListener(RESET_EVENT, onReset);
  }, []);

  const currentStep = ONBOARDING_STEPS[state.step] ?? "welcome";
  const isVisible = mounted && !state.dismissed && !state.completed;
  const progress = mounted ? (state.step + 1) / ONBOARDING_STEPS.length : 0;

  const goToStep = useCallback((index: number) => {
    setState((prev) => {
      const next = { ...prev, step: Math.max(0, Math.min(index, ONBOARDING_STEPS.length - 1)) };
      saveState(next);
      return next;
    });
  }, []);

  const nextStep = useCallback(() => {
    setState((prev) => {
      const nextStep = prev.step + 1;
      if (nextStep >= ONBOARDING_STEPS.length) {
        const next = { ...prev, step: ONBOARDING_STEPS.length - 1, completed: true };
        saveState(next);
        return next;
      }
      const next = { ...prev, step: nextStep };
      saveState(next);
      return next;
    });
  }, []);

  const prevStep = useCallback(() => {
    setState((prev) => {
      const next = { ...prev, step: Math.max(0, prev.step - 1) };
      saveState(next);
      return next;
    });
  }, []);

  const dismiss = useCallback(() => {
    const next = { ...state, dismissed: true };
    setState(next);
    saveState(next);
  }, [state]);

  const complete = useCallback(() => {
    const next = { ...state, completed: true };
    setState(next);
    saveState(next);
  }, [state]);

  const reset = useCallback(() => {
    setState(DEFAULT_STATE);
    saveState(DEFAULT_STATE);
  }, []);

  return {
    state,
    currentStep,
    isVisible,
    progress,
    mounted,
    goToStep,
    nextStep,
    prevStep,
    dismiss,
    complete,
    reset,
  };
}