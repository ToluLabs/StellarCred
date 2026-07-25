"use client";

import { useState, useEffect, useCallback } from "react";
import { hasSeenTour, markTourSeen } from "@/lib/onboarding";
import { IconArrowRight, IconArrowLeft, IconX } from "@tabler/icons-react";

interface Step {
  target: string;
  title: string;
  body: string;
  placement: "bottom" | "top" | "left" | "right";
}

const TOUR_STEPS: Step[] = [
  { target: "#nav-verify", title: "Get a credential", body: "Verify an attribute about yourself. Your data stays in your browser and never touches any server.", placement: "bottom" },
  { target: "#nav-holder", title: "Generate a proof", body: "Prove the claim locally with zero-knowledge. Nothing sensitive leaves your device — only the proof goes on-chain.", placement: "bottom" },
  { target: "#nav-apps", title: "Use it everywhere", body: "Browse protocols that accept StellarCred credentials. One proof unlocks access across the entire ecosystem.", placement: "bottom" },
  { target: "#nav-docs", title: "Build with it", body: "Integrate StellarCred into your own protocol with a single SDK call. No backend, no API key, no re-verification.", placement: "bottom" },
];

export function OnboardingTour() {
  const [currentStep, setCurrentStep] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!hasSeenTour()) {
      const timer = setTimeout(() => setIsVisible(true), 600);
      return () => clearTimeout(timer);
    }
  }, []);

  const positionTooltip = useCallback((stepIndex: number) => {
    const step = TOUR_STEPS[stepIndex];
    const targetEl = document.querySelector(step.target);
    if (!targetEl) return;
    const targetRect = targetEl.getBoundingClientRect();
    const padding = 16;
    const maxWidth = 320;
    const placements: Record<string, React.CSSProperties> = {
      bottom: { top: targetRect.bottom + padding, left: Math.max(padding, targetRect.left + targetRect.width / 2 - maxWidth / 2), maxWidth },
      top: { top: targetRect.top - padding - 120, left: Math.max(padding, targetRect.left + targetRect.width / 2 - maxWidth / 2), maxWidth },
      right: { top: targetRect.top + targetRect.height / 2 - 60, left: targetRect.right + padding, maxWidth },
      left: { top: targetRect.top + targetRect.height / 2 - 60, left: Math.max(padding, targetRect.left - maxWidth - padding), maxWidth },
    };
    setTooltipStyle(placements[step.placement] || placements.bottom);
    targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
    targetEl.classList.add("tour-highlight");
  }, []);

  useEffect(() => {
    if (isVisible) positionTooltip(currentStep);
    return () => { document.querySelectorAll(".tour-highlight").forEach((el) => el.classList.remove("tour-highlight")); };
  }, [isVisible, currentStep, positionTooltip]);

  const handleNext = () => {
    document.querySelectorAll(".tour-highlight").forEach((el) => el.classList.remove("tour-highlight"));
    if (currentStep < TOUR_STEPS.length - 1) setCurrentStep((s) => s + 1);
    else handleDismiss();
  };

  const handlePrev = () => {
    document.querySelectorAll(".tour-highlight").forEach((el) => el.classList.remove("tour-highlight"));
    if (currentStep > 0) setCurrentStep((s) => s - 1);
  };

  const handleDismiss = () => { setIsVisible(false); markTourSeen(); document.querySelectorAll(".tour-highlight").forEach((el) => el.classList.remove("tour-highlight")); };

  if (!isVisible) return null;

  const step = TOUR_STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === TOUR_STEPS.length - 1;

  return (
    <>
      <div className="tour-overlay" onClick={handleDismiss} aria-hidden="true" />
      <div className="tour-tooltip" style={tooltipStyle} role="dialog" aria-label={`Onboarding step ${currentStep + 1} of ${TOUR_STEPS.length}: ${step.title}`}>
        <button className="tour-close" onClick={handleDismiss} aria-label="Close tour" type="button"><IconX size={16} stroke={2} /></button>
        <div className="tour-step-indicator">{currentStep + 1} of {TOUR_STEPS.length}</div>
        <h3 className="tour-title">{step.title}</h3>
        <p className="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button className="btn btn-secondary btn-sm" onClick={handlePrev} disabled={isFirst} type="button"><IconArrowLeft size={14} />Back</button>
          <button className="btn btn-primary btn-sm" onClick={handleNext} type="button">{isLast ? "Finish" : "Next"}<IconArrowRight size={14} /></button>
        </div>
        <button className="tour-skip" onClick={handleDismiss} type="button">Skip tour</button>
      </div>
    </>
  );
}

