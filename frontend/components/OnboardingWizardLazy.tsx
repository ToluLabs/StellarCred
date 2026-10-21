"use client";

// Next.js forbids `next/dynamic` with `ssr: false` inside Server Components,
// so layout.tsx's OnboardingWizard lazy-load lives in this client wrapper
// instead. Same split behaviour: the OnboardingWizard chunk is only fetched
// (and never server-rendered) in the browser.
//
// OnboardingWizard is a large component (~18 kB, with several @tabler/icons)
// that is only shown to first-time users. Deferring it here removes it from
// every route's initial server-rendered HTML and keeps its icons in a
// separate chunk that's only downloaded if the wizard actually needs to show.
import dynamic from "next/dynamic";

const OnboardingWizard = dynamic(
  () => import("@/components/OnboardingWizard").then((m) => m.OnboardingWizard),
  { ssr: false },
);

export default OnboardingWizard;
