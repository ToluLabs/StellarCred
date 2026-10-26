const fs = require('fs');
const glob = require('glob');

const files = glob.sync('services/indexer/src/ingester.ts');
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/upsertClaim\(\{\s*([\s\S]*?)\}\)/g, (match, body) => {
    if (!body.includes('reason_code')) {
      return `upsertClaim({\n      reason_code: "other",\n      ${body}})`;
    }
    return match;
  });
  fs.writeFileSync(file, content);
});
