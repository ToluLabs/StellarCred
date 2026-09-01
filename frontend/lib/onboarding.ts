"use client";

import { useState, useEffect, useCallback } from "react";
import { isStorageAvailable } from "./safe-storage";

const STORAGE_KEY = "stellarcred:onboarding";
const RESET_EVENT = "stellarcred:onboarding:reset";

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
  /** Current step index (0-based). */
  step: number;
  /** Whether the wizard has been dismissed. */
  dismissed: boolean;
  /** Whether the user completed the full wizard. */
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
    if (!raw) return DEFAULT_STATE;
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

/**
 * Whether the onboarding wizard should be shown.
 * Returns true if the user has never dismissed or completed it.
 */
export function shouldShowOnboarding(): boolean {
  const state = loadState();
  return !state.dismissed && !state.completed;
}

/**
 * Reset onboarding state so the wizard will show again on next page load.
 * Used by the "Take tour" nav button.
 */
export function resetOnboarding(): void {
  saveState(DEFAULT_STATE);
  // Dispatch a custom event so the wizard re-renders immediately
  // without a full page reload.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(RESET_EVENT));
  }
}

/**
 * Hook to manage onboarding wizard state.
 *
 * Tracks progress in localStorage so the wizard is resumable and
 * persistent across page reloads. Returning users who completed or
 * dismissed the wizard will never see it again.
 */
export function useOnboarding() {
  const [state, setState] = useState<OnboardingState>(DEFAULT_STATE);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setState(loadState());
    setMounted(true);

    // Listen for external resets (e.g. "Take tour" nav button)
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
