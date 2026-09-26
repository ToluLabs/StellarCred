"use client";

import { useCallback, useEffect, useState } from "react";
import { hasSeenTour, markTourSeen } from "@/lib/onboarding";

interface Step {
  target: string;
  title: string;
  body: string;
  placement: "bottom" | "top" | "right" | "left";
}

const TOUR_STEPS: Step[] = [
  {
    target: "#nav-verify",
    title: "Get a credential",
    body: "Verify an attribute about yourself. Your data stays in your browser and never touches any server.",
    placement: "bottom",
  },
  {
    target: "#nav-holder",
    title: "Generate a proof",
    body: "Prove the claim locally with zero-knowledge. Nothing sensitive leaves your device - only the proof goes on-chain.",
    placement: "bottom",
  },
  {
    target: "#nav-docs",
    title: "Read the docs",
    body: "Browse guides on issuing credentials, verifying claims, and building ZK apps.",
    placement: "bottom",
  },
  {
    target: "#nav-apps",
    title: "Explore apps",
    body: "See real-world integrations that use StellarCred for privacy-preserving verification.",
    placement: "bottom",
  },
];

export function OnboardingTour() {
  const [isVisible, setIsVisible] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});

  const positionTooltip = useCallback((stepIndex: number) => {
    const step = TOUR_STEPS[stepIndex];
    if (!step) return;

    const targetEl = document.querySelector(step.target);
    if (!targetEl) {
      setTooltipStyle({
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        maxWidth: 320,
      });
      return;
    }

    const targetRect = targetEl.getBoundingClientRect();
    const padding = 16;
    const maxWidth = 320;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const clampLeft = (left: number) =>
      Math.min(Math.max(padding, left), viewportWidth - maxWidth - padding);

    const clampTop = (top: number) =>
      Math.min(Math.max(padding, top), viewportHeight - 200);

    const placements: Record<string, React.CSSProperties> = {
      bottom: {
        top: clampTop(targetRect.bottom + padding),
        left: clampLeft(targetRect.left + targetRect.width / 2 - maxWidth / 2),
        maxWidth,
      },
      top: {
        top: clampTop(targetRect.top - padding - 120),
        left: clampLeft(targetRect.left + targetRect.width / 2 - maxWidth / 2),
        maxWidth,
      },
      right: {
        top: clampTop(targetRect.top + targetRect.height / 2 - 60),
        left: clampLeft(targetRect.right + padding),
        maxWidth,
      },
      left: {
        top: clampTop(targetRect.top + targetRect.height / 2 - 60),
        left: clampLeft(targetRect.left - maxWidth - padding),
        maxWidth,
      },
    };

    setTooltipStyle(placements[step.placement] || placements.bottom);
    targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
    targetEl.classList.add("tour-highlight");
  }, []);

  useEffect(() => {
    if (hasSeenTour()) return;
    setIsVisible(true);
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    positionTooltip(stepIndex);
  }, [isVisible, stepIndex, positionTooltip]);

  useEffect(() => {
    if (!isVisible) return;
    const handleResize = () => positionTooltip(stepIndex);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isVisible, stepIndex, positionTooltip]);

  const handleDismiss = () => {
    setIsVisible(false);
    markTourSeen();
    document.querySelectorAll(".tour-highlight").forEach((el) => {
      el.classList.remove("tour-highlight");
    });
  };

  const handleNext = () => {
    if (stepIndex < TOUR_STEPS.length - 1) {
      setStepIndex(stepIndex + 1);
    } else {
      handleDismiss();
    }
  };

  if (!isVisible) return null;

  const step = TOUR_STEPS[stepIndex];

  return (
    <div
      className="tour-overlay"
      onClick={handleDismiss}
      role="dialog"
      aria-modal="true"
      aria-label="Onboarding tour"
    >
      <div
        className="tour-tooltip"
        style={tooltipStyle}
        onClick={(e) => e.stopPropagation()}
        role="document"
      >
        <button
          className="tour-close"
          onClick={handleDismiss}
          aria-label="Close tour"
        >
          ✕
        </button>
        <p className="tour-step-indicator">
          Step {stepIndex + 1} of {TOUR_STEPS.length}
        </p>
        <h3 className="tour-title">{step.title}</h3>
        <p className="tour-body">{step.body}</p>
        <div className="tour-actions">
          <button className="btn btn-primary btn-sm" onClick={handleNext}>
            {stepIndex < TOUR_STEPS.length - 1 ? "Next" : "Done"}
          </button>
        </div>
        <button className="tour-skip" onClick={handleDismiss}>
          Skip tour
        </button>
      </div>
    </div>
  );
}