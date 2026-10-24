// frontend/lib/test-utils.tsx
// Shared test utilities for components that call useTranslations().
// Wraps the given UI in NextIntlClientProvider so that next-intl hooks work
// inside a vitest/jsdom environment without a real Next.js App Router context.

import React from "react";
import { render, type RenderResult } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../public/locales/en.json";

export function renderWithIntl(ui: React.ReactElement): RenderResult {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}
