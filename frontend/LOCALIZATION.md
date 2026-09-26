# Localization Guide for StellarCred

This guide explains how to add new locales (languages) to StellarCred. The current implementation supports English (en) and Spanish (es) as proof-of-concept. Adding new locales is straightforward.

## Quick Start: Adding a New Locale

### 1. Create a Translation File

Create a new JSON file in `frontend/public/locales/` named `{locale}.json`, where `{locale}` is the BCP 47 language code (e.g., `fr` for French, `de` for German, `pt` for Portuguese).

**Example:** `frontend/public/locales/fr.json`

Use `frontend/public/locales/en.json` as your template. Copy all keys and values, then translate the values to your target language.

```json
{
  "common": {
    "loading": "Chargement...",
    "close": "Fermer",
    "retry": "Réessayer",
    ...
  },
  "nav": {
    "brand": "StellarCred",
    "wallet": "Portefeuille",
    ...
  },
  ...
}
```

**Important:** Maintain the exact same key structure. Only translate the values.

### 2. Update `i18n.config.ts`

Add your new locale to the configuration:

```typescript
// frontend/i18n.config.ts

export const locales = ['en', 'es', 'fr'] as const;  // Add 'fr' here

export const messages = {
  en: () => import('./public/locales/en.json').then((module) => module.default),
  es: () => import('./public/locales/es.json').then((module) => module.default),
  fr: () => import('./public/locales/fr.json').then((module) => module.default),  // Add this
} as const;

export const localeNames: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',  // Add this
};
```

### 3. Update `lib/i18n.ts` (if needed)

If your locale uses non-standard date/number formatting, update the `getLocaleString()` function:

```typescript
export function getLocaleString(locale: Locale): string {
  const localeMap: Record<Locale, string> = {
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',  // Add this
  };
  return localeMap[locale] || locale;
}
```

Use standard [BCP 47 language tags](https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry) and [Unicode CLDR locale identifiers](https://cldr.unicode.org/) as reference.

### 4. Update `components/LanguageSwitcher.tsx` (optional)

The language switcher automatically picks up new locales from `i18n.config.ts`, so **no changes needed here** unless you want to add locale-specific flags or icons.

### 5. Update `components/LocaleMetaTags.tsx` (optional)

For hreflang meta tags to be correct, verify the locale mapping is accurate. The component uses:

```typescript
hrefLang={loc === "en" ? "en-US" : `${loc}-${loc.toUpperCase()}`}
```

This works for most locales. If your locale needs a different region code (e.g., `pt-BR` for Brazilian Portuguese instead of `pt-PT`), update the mapping in `LocaleMetaTags.tsx`:

```typescript
const hrefLangMap: Record<Locale, string> = {
  en: 'en-US',
  es: 'es-ES',
  pt: 'pt-BR',  // Customize if needed
};
```

## Translation Keys Reference

The translation system uses hierarchical key organization. Here are the main sections:

- **`common`** - Shared UI strings (loading, close, retry, etc.)
- **`nav`** - Navigation labels and menu items
- **`footer`** - Footer content and version info
- **`theme`** - Dark/light mode labels
- **`wallet`** - Wallet connection UI strings
- **`home`** - Homepage content (hero, stats, features)
- **`network`** - Network-related messages and warnings
- **`config`** - Configuration and deployment messages
- **`credential`** - Credential modal labels and buttons
- **`errors`** - Error messages and titles
- **`formats`** - Date/time formatting specifications (for reference, not translated)

## String Interpolation

Some strings use placeholders for dynamic values. Use the exact same placeholders in your translations:

```json
{
  "network": {
    "wrongNetwork": "Wrong network detected. Switch your wallet to {network} to continue.",
    ...
  }
}
```

The `{network}` placeholder will be replaced at runtime. Do NOT translate placeholder names, only the surrounding text.

## Date and Number Formatting

Dates and numbers are formatted automatically using the browser's Intl API based on the locale. No translation needed for these—they're handled by:

- `formatDate()` - Formats dates per locale (Jan 15, 2024 vs 15 ene 2024)
- `formatDateTime()` - Formats date + time per locale
- `formatNumber()` - Formats numbers per locale
- `formatCurrency()` - Formats currency per locale

## Testing Your Translation

### 1. Build the app
```bash
cd frontend
pnpm install  # Install dependencies
pnpm build    # Build the app
```

### 2. Run the dev server
```bash
pnpm dev
```

### 3. Test language switching
1. Open http://localhost:3000 in your browser
2. Click the language switcher in the top-right corner
3. Verify your new locale appears in the dropdown
4. Select it and verify:
   - The URL updates to `/fr` (or your locale code)
   - All visible text is translated
   - Dates and numbers format correctly
   - The page reloads cleanly

### 4. Check all pages
Visit these key pages to verify translations are complete:
- `/` - Homepage
- `/holder` - Holder dashboard
- `/verify` - Credential verification
- `/issuer` - Issuer interface
- `/apps` - Protocol apps listing
- `/developers` - Developer docs
- `/docs` - Documentation

## Completing a Translation: Checklist

- [ ] Created `frontend/public/locales/{locale}.json` with all keys from `en.json`
- [ ] Translated all values to the target language
- [ ] Added locale to `locales` array in `i18n.config.ts`
- [ ] Added dynamic import in `messages` object in `i18n.config.ts`
- [ ] Added locale name to `localeNames` in `i18n.config.ts`
- [ ] Updated `getLocaleString()` in `lib/i18n.ts` if needed
- [ ] Tested language switching in dev mode
- [ ] Verified all pages display translations correctly
- [ ] Checked date/number formatting per locale
- [ ] (Optional) Submitted translation for community review

## Common Issues and Troubleshooting

### Language not appearing in switcher
**Check:**
1. Locale is added to `locales` array in `i18n.config.ts`
2. Locale is exported from the `const locales` declaration
3. App has been rebuilt (`pnpm build`) or dev server restarted

### Translations not showing
**Check:**
1. JSON file path is correct: `frontend/public/locales/{locale}.json`
2. JSON syntax is valid (no missing commas, quotes, or braces)
3. Keys match exactly from `en.json` (case-sensitive)
4. No special characters in keys that break JSON

### Dates formatting incorrectly
**Check:**
1. Locale string is correct in `getLocaleString()` (e.g., `fr-FR` not `fr`)
2. Browser/system locale settings aren't overriding
3. Components are using `formatDate()` or `formatDateTime()` utilities

### Performance concerns
The translation system uses **dynamic imports** to code-split locale files. Each locale adds ~5-10KB to the bundle when used. This is efficient and doesn't affect unused locales.

## Architecture Overview

### File Structure
```
frontend/
├── i18n.config.ts              # Locale definitions and imports
├── i18n/
│   └── request.ts              # Server-side i18n setup
├── lib/
│   └── i18n.ts                 # Formatting utilities (numbers, dates, currency)
├── components/
│   ├── LanguageSwitcher.tsx    # Language dropdown menu
│   └── LocaleMetaTags.tsx      # hreflang meta tags for SEO
├── middleware.ts               # Locale routing via next-intl
├── public/locales/
│   ├── en.json                 # English (source language)
│   └── es.json                 # Spanish (proof of i18n)
└── app/
    └── layout.tsx              # Root layout with i18n setup
```

### Technology Stack
- **next-intl** (v3.16.0) - Next.js 14 i18n library
- **Intl API** - Browser native date/number formatting
- **Middleware** - Transparent locale routing (/es/*, not /en/*)
- **localStorage** - Persists user's locale preference

### Routing Behavior
- `/` → English (default)
- `/es/*` → Spanish
- `/fr/*` → French (once added)
- Middleware handles transparent routing—no file reorganization needed

### Translation Usage in Code

**Server components:**
```typescript
import { getTranslations } from 'next-intl/server';

export default function Page() {
  const t = getTranslations();
  return <h1>{t('home.hero.title')}</h1>;
}
```

**Client components:**
```typescript
'use client';

import { useTranslations } from 'next-intl';

export function Component() {
  const t = useTranslations();
  return <button>{t('common.close')}</button>;
}
```

## Adding More Features to i18n

### New Date Format
Add to `public/locales/{locale}.json`:
```json
{
  "formats": {
    "dateTime": {
      "short": "MMM d, yyyy",
      "long": "EEEE, MMMM d, yyyy"
    }
  }
}
```

Then use in components:
```typescript
import { useTranslations } from 'next-intl';

const t = useTranslations('formats.dateTime');
const format = t('short'); // "MMM d, yyyy"
```

### Plural Forms (advanced)
next-intl supports plural rules out of the box:
```typescript
t('items', { count: 5 }); // Uses locale-specific plural rules
```

Add to JSON:
```json
{
  "items": "{count, plural, one {# item} other {# items}}"
}
```

## Resources

- [next-intl Documentation](https://next-intl-docs.vercel.app/)
- [BCP 47 Language Tags](https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry)
- [Unicode CLDR Locales](https://cldr.unicode.org/)
- [Intl API Reference](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl)

## Contributing Translations

To contribute a translation to the StellarCred project:

1. Fork the repository
2. Follow the "Adding a New Locale" steps above
3. Ensure all strings are translated (use checklist)
4. Test thoroughly on all pages
5. Submit a pull request with:
   - New locale file(s)
   - Updated `i18n.config.ts`
   - Updated `lib/i18n.ts` (if needed)
   - Brief description of the translation

Community translations are welcome! Current supported locales: English, Spanish.
