import 'dotenv/config';
import { Database } from '../src/database.js';
const db = new Database();
const PHANTOM_ACCOUNTS = ['Funded 4', 'Funded 5', 'Funded 6'];
const now = new Date().toISOString();
const admin = db.findUserByEmail((process.env.ADMIN_USER_EMAIL ?? '').toLowerCase());
if (!admin) throw new Error('admin not found');
const all = db.listAccounts(admin.id);
for (const name of PHANTOM_ACCOUNTS) {
  const acct = all.find((a) => a.name === name);
  if (!acct) { console.log('missing', name); continue; }
  const armed = db.listBracketMonitorEntriesForAdoption(acct.id).filter((m) => m.state === 'armed');
  for (const m of armed) {
    db.retireBracketMonitorEntry(admin.id, m, 'entry_cancelled', `phantom-arm-cleanup-${m.bracketId}`, now);
    console.log('retired', name, m.bracketId, m.side);
  }
}
console.log('done');
