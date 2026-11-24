/**
 * i18n request handler for server components
 *
 * Provides locale and messages to server components using next-intl.
 */

import { getRequestConfig } from 'next-intl/server';
import { hasLocale } from 'next-intl';
import { messages, locales, Locale, defaultLocale } from '@/i18n.config';

// next-intl v4 replaced the resolved `locale` parameter with the async
// `requestLocale` (which honours the x-next-intl-locale header set by
// middleware.ts and the NEXT_LOCALE cookie).
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;

  // Fall back to defaultLocale if middleware did not supply one
  const currentLocale = hasLocale(locales, requested)
    ? (requested as Locale)
    : defaultLocale;

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
