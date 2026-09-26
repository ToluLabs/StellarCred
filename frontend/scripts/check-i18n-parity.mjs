import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolves relative to scripts/ directory to frontend/public/locales
const LOCALES_DIR = path.resolve(__dirname, '../public/locales');
const DEFAULT_LOCALE = 'en.json';

function getLeafKeys(obj, prefix = '') {
  let keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...getLeafKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function runCheck() {
  if (!fs.existsSync(LOCALES_DIR)) {
    console.error(`❌ Locales directory not found at ${LOCALES_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));

  if (!files.includes(DEFAULT_LOCALE)) {
    console.error(`❌ Default locale file ${DEFAULT_LOCALE} missing in ${LOCALES_DIR}`);
    process.exit(1);
  }

  const defaultContent = JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, DEFAULT_LOCALE), 'utf8')
  );
  const defaultKeys = new Set(getLeafKeys(defaultContent));

  let hasErrors = false;

  for (const file of files) {
    if (file === DEFAULT_LOCALE) continue;

    const content = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
    const currentKeys = new Set(getLeafKeys(content));

    const missingKeys = [...defaultKeys].filter((k) => !currentKeys.has(k));
    const extraKeys = [...currentKeys].filter((k) => !defaultKeys.has(k));

    if (missingKeys.length > 0 || extraKeys.length > 0) {
      hasErrors = true;
      console.error(`\n❌ i18n key mismatch found in ${file}:`);
      if (missingKeys.length > 0) {
        console.error(`  Missing keys (present in ${DEFAULT_LOCALE}):`);
        missingKeys.forEach((k) => console.error(`    - ${k}`));
      }
      if (extraKeys.length > 0) {
        console.error(`  Extra keys (not in ${DEFAULT_LOCALE}):`);
        extraKeys.forEach((k) => console.error(`    - ${k}`));
      }
    }
  }

  if (hasErrors) {
    console.error('\n❌ Locale key parity check failed.');
    process.exit(1);
  } else {
    console.log(`✅ i18n parity check passed across ${files.length} locale files.`);
  }
}

runCheck();
