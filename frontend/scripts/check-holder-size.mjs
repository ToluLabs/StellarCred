import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOLDER_PAGE = path.resolve(__dirname, '../app/holder/HolderPageClient.tsx');
const MAX_LINES = 500;

function runCheck() {
  if (!fs.existsSync(HOLDER_PAGE)) {
    console.error(`❌ HolderPageClient.tsx not found at ${HOLDER_PAGE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(HOLDER_PAGE, 'utf8');
  const lines = content.split('\n').length;

  if (lines > MAX_LINES) {
    console.error(`\n❌ HolderPageClient.tsx has ${lines} lines, exceeding the maximum allowed ${MAX_LINES} lines.`);
    console.error('Please keep feature state in lib/hooks/ and presentational blocks in components/holder/.\n');
    process.exit(1);
  }

  console.log(`✅ HolderPageClient.tsx size check passed (${lines} lines <= ${MAX_LINES} limit).`);
}

runCheck();
