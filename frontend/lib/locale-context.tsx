"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import { locales, defaultLocale, getLocale, setLocale, type Locale } from "@/lib/i18n";

interface LocaleContextValue {
  locale: Locale;
  changeLocale: (l: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: defaultLocale,
  changeLocale: () => {},
});

export function useLocale() {
  return useContext(LocaleContext);
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(defaultLocale);
  const [messages, setMessages] = useState<AbstractIntlMessages | null>(null);

  // Hydrate locale from localStorage on mount
  useEffect(() => {
    const stored = getLocale();
    setLocaleState(stored);
    import(`../messages/${stored}.json`).then((m) => setMessages(m.default));
  }, []);

  function changeLocale(l: Locale) {
    setLocale(l);
    setLocaleState(l);
    import(`../messages/${l}.json`).then((m) => setMessages(m.default));
  }

  if (!messages) return null;

  return (
    <LocaleContext.Provider value={{ locale, changeLocale }}>
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}

export { locales };
