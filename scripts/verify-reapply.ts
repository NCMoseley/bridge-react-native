import 'dotenv/config';
import { Database } from '../src/database.js';

const accountId = process.argv[2] ?? '8e1e97b9-9c1b-4938-a03d-486cb3e1639d';
const instrument = process.argv[3] ?? 'MNQ1!';
const excludeRangeName = process.argv[4] ?? '';

const database = new Database();

const armed = database.getArmedBracketsForReapply(accountId, instrument, excludeRangeName);
console.log(`Found ${armed.length} armed brackets for ${accountId} / ${instrument}`);

for (const arm of armed) {
  const latest = database.getLatestBracketOrderPayload(arm.rangeName, arm.bracketId, arm.side, instrument);
  console.log({
    range: arm.rangeName,
    side: arm.side,
    bracketId: arm.bracketId,
    found: latest != null,
  });
}

