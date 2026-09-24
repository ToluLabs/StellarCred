/**
 * i18n utilities for StellarCred
 */

import { Locale } from '@/i18n.config';

/**
 * Format a number according to locale
 */
export function formatNumber(
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Format a date according to locale
 * Expects Unix timestamp (seconds) or Date object
 */
export function formatDate(
  dateOrTimestamp: Date | number,
  locale: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = typeof dateOrTimestamp === 'number' 
    ? new Date(dateOrTimestamp * 1000)
    : dateOrTimestamp;
  
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  };

  return new Intl.DateTimeFormat(locale, options || defaultOptions).format(date);
}

/**
 * Format a date and time according to locale
 * Expects Unix timestamp (seconds) or Date object
 */
export function formatDateTime(
  dateOrTimestamp: Date | number,
  locale: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const date = typeof dateOrTimestamp === 'number' 
    ? new Date(dateOrTimestamp * 1000)
    : dateOrTimestamp;
  
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  };

  return new Intl.DateTimeFormat(locale, options || defaultOptions).format(date);
}

/**
 * Format a currency value according to locale
 */
export function formatCurrency(
  value: number,
  locale: string,
  currency: string
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(value);
}

/**
 * Get locale string (e.g., 'en-US') from Locale type
 * Useful for Intl APIs
 */
export function getLocaleString(locale: Locale): string {
  const localeMap: Record<Locale, string> = {
    en: 'en-US',
    es: 'es-ES',
  };
  return localeMap[locale] || locale;
}
