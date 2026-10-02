import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../src/database.js';
import { atmTemplateFileName, renderNt8AtmTemplateXml } from '../src/atm-template.js';

// Generates NT8 ATM strategy template XML files — one per break-even-enabled
// range configuration. Drop the output files into
// `Documents\NinjaTrader 8\templates\AtmStrategy\` on the NT8 host.
// The same XML is downloadable per range via GET /app/api/ranges/:name/atm-template.
//
// Usage: npx tsx scripts/generate-nt8-atm-templates.ts [outdir]

const OUT_DIR = process.argv[2] ?? './nt8-atm-templates';

const db = new Database();
// test_data-flagged ranges (SIM-* e2e fixtures) are excluded — prod templates
// are only generated for real ranges.
const testDataRanges = new Set(
  db.listRangeReviewFlags()
    .filter((f) => f.reason === 'test_data')
    .map((f) => f.rangeName),
);
const beRanges = db.listRangeConfigurations()
  .filter((c) => c.breakEvenEnabled && !testDataRanges.has(c.rangeName));
if (beRanges.length === 0) {
  console.log('No break-even-enabled range configurations — nothing to generate.');
  db.close();
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const config of beRanges) {
  const fileName = atmTemplateFileName(config.rangeName);
  const outPath = path.join(OUT_DIR, fileName);
  fs.writeFileSync(outPath, renderNt8AtmTemplateXml(config), 'utf8');
  console.log(
    `${config.rangeName}: trigger=${Math.round(config.breakEvenTriggerTicksCents / 100)}t`
    + ` offset=+${Math.round(config.breakEvenOffsetTicksCents / 100)}t -> ${outPath}`,
  );
}

console.log(`\n${beRanges.length} template(s) written to ${path.resolve(OUT_DIR)}`);
console.log('Copy them to Documents\\NinjaTrader 8\\templates\\AtmStrategy\\ on the NT8 host,');
console.log('then verify with the Debugging → CrossTrade broker state ATM preflight.');
db.close();
