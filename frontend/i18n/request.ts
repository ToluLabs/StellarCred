/**
 * i18n request handler for server components
 * 
 * Provides locale and messages to server components using next-intl.
 */

import { getRequestConfig } from 'next-intl/server';
import { messages, locales, Locale, defaultLocale } from '@/i18n.config';

export default getRequestConfig(async ({ locale }) => {
  // Fall back to defaultLocale if middleware did not supply one
  const currentLocale =
    locale && locales.includes(locale as Locale) ? (locale as Locale) : defaultLocale;

  // Dynamically import messages for the requested locale
  const messageModule = messages[currentLocale];
  if (!messageModule) {
    throw new Error(`No messages found for locale: ${currentLocale}`);
  }

  return {
    locale: currentLocale,
    messages: await messageModule(),
    timeZone: 'UTC',
    now: new Date(),
  };
});
