/**
 * i18n Configuration for next-intl
 * 
 * Defines supported locales, default locale, and message catalog.
 */

export const locales = ['en', 'es'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

export const messages = {
  en: () => import('./public/locales/en.json').then((module) => module.default),
  es: () => import('./public/locales/es.json').then((module) => module.default),
} as const;

export const localeNames: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
};
