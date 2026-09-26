/**
 * i18n request handler for server components
 * 
 * Provides locale and messages to server components using next-intl.
 */

import { getRequestConfig } from 'next-intl/server';
import { messages, locales, Locale } from '@/i18n.config';

export default getRequestConfig(async ({ locale }) => {
  // Validate that the requested locale is supported
  if (!locales.includes(locale as Locale)) {
    throw new Error(`Invalid locale: ${locale}`);
  }

  // Dynamically import messages for the requested locale
  const messageModule = messages[locale as Locale];
  if (!messageModule) {
    throw new Error(`No messages found for locale: ${locale}`);
  }

  return {
    messages: await messageModule(),
    timeZone: 'UTC',
    now: new Date(),
  };
});
