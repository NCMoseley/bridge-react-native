// Seed the e2e database: admin + viewer users, two accounts pointed at the mock
// TradersPost, 14 tracked ranges across 4 instruments, two subcategories.
// Run with: DATABASE_PATH=... npx tsx scripts/e2e/seed.ts > <workdir>/ids.json
import { existsSync } from 'node:fs';
import { assertIsolation } from './isolation.mjs';
import { Database } from '../../src/database.js';
import { createSessionToken, hashSessionToken } from '../../src/auth.js';

const MOCK_BASE = process.env.MOCK_BASE_URL || 'http://localhost:3199';
const SESSION_SECRET = process.env.SESSION_SECRET || 'pt-session-secret-0000000000000000';

const LIVE = process.env.PT_E2E_LIVE === '1';
assertIsolation();
if (!LIVE && existsSync(process.env.DATABASE_PATH!)) throw new Error('Refusing to seed an existing database');
const db = new Database();
// clean-live.mjs must know exactly which rows this seed created versus reused —
// pre-existing rows in a shared database are never deleted.
const created = { userIds: [] as string[], accountIds: [] as string[], rangeNames: [] as string[], subcategoryNames: [] as string[] };
const reused = { userIds: [] as string[], accountIds: [] as string[], rangeNames: [] as string[], subcategoryNames: [] as string[] };
const findOrCreateUser = (email: string) => {
  const existing = db.findUserByEmail(email);
  if (existing) { reused.userIds.push(existing.id); return existing; }
  const user = db.createUser(email);
  created.userIds.push(user.id);
  return user;
};
// Live mode seeds under the configured admin so the driver session passes
// admin checks (isAdmin = session.email === ADMIN_USER_EMAIL).
const admin = findOrCreateUser((process.env.ADMIN_USER_EMAIL || 'admin@e2e.local').toLowerCase());
const viewer = findOrCreateUser('viewer@e2e.local');
const findOrCreateAccount = (name: string) => {
  const existing = db.listAccounts(admin.id).find(a => a.name === name);
  if (existing) { reused.accountIds.push(existing.id); return existing; }
  const account = db.createAccount({ userId: admin.id, name, startingBalanceCents: 0 });
  created.accountIds.push(account.id);
  return account;
};
const acct1 = findOrCreateAccount('PT-ACCT-1');
const acct2 = findOrCreateAccount('PT-ACCT-2');

(db as any).upsertTradersPostAccountDestination(
  admin.id, acct1.id, `${MOCK_BASE}/tp/a1`,
  undefined, undefined, true, false, false, '16:30', '16:45', true, false, 5, true,
);
(db as any).upsertTradersPostAccountDestination(
  admin.id, acct2.id, `${MOCK_BASE}/tp/a2`,
  undefined, undefined, true, false, false, '16:30', '16:45', true, false, 5, true,
);

const findOrCreateSubcategory = (name: string) => {
  if ((db as any).db.prepare('SELECT 1 FROM range_subcategories WHERE name = ?').get(name)) {
    reused.subcategoryNames.push(name);
    return;
  }
  db.createRangeSubcategory(name, admin.id);
  created.subcategoryNames.push(name);
};
findOrCreateSubcategory('PT-MOMENTUM');
findOrCreateSubcategory('PT-MEANREV');

// [rangeName, instrument, accounts, subcategory?]
const RANGES: Array<[string, string, number[], string?]> = [
  ['PT-MNQ-A', 'MNQ1!', [1, 2], 'PT-MOMENTUM'],
  ['PT-MNQ-B', 'MNQ1!', [1, 2], 'PT-MOMENTUM'],
  ['PT-MNQ-C', 'MNQ1!', [1, 2], 'PT-MOMENTUM'],
  ['PT-MNQ-D', 'MNQ1!', [1], 'PT-MOMENTUM'],
  ['PT-MNQ-E', 'MNQ1!', [1, 2], 'PT-MEANREV'],
  ['PT-MNQ-F', 'MNQ1!', [2], 'PT-MEANREV'],
  ['PT-MGC-A', 'MGC1!', [1], 'PT-MEANREV'],
  ['PT-MGC-B', 'MGC1!', [1], 'PT-MEANREV'],
  ['PT-MGC-C', 'MGC1!', [1]],
  ['PT-MGC-D', 'MGC1!', [1]],
  ['PT-NQ-A', 'NQ1!', [1]],
  ['PT-NQ-B', 'NQ1!', [2]],
  ['PT-ES-A', 'ES1!', [1]],
  ['PT-ES-B', 'ES1!', [1]],
];

const accounts = { 1: acct1, 2: acct2 } as Record<number, typeof acct1>;
// Pass 1: ranges + configs + model memberships BEFORE any routes exist.
// Membership-add propagates routes to accounts subscribed to the whole model —
// declaring all members first keeps the explicit route matrix below untouched.
for (const [rangeName, instrument, , sub] of RANGES) {
  if ((db as any).db.prepare('SELECT 1 FROM tracked_ranges WHERE range_name = ?').get(rangeName)) {
    reused.rangeNames.push(rangeName);
  } else {
    db.createTrackedRange(rangeName, admin.id);
    created.rangeNames.push(rangeName);
  }
  db.upsertRangeConfiguration({
    rangeName, instrument, description: '',
    riskDollarsCents: 10_000, rangeWindow: '0000-2359', tradingSession: '',
    takeProfitStyle: 'ticks', takeProfitTicksCents: 1_000,
    stopLossStyle: 'ticks', stopLossTicksCents: 1_000,
    breakEvenEnabled: false, breakEvenTriggerTicksCents: 0, breakEvenOffsetTicksCents: 0, ocoMode: 'oco', stopOnlyEntries: true,
    runMonday: true, runTuesday: true, runWednesday: true, runThursday: true,
    runFriday: true, runSaturday: true, runSunday: true,
    entriesPerRange: 2,
  });
  if (sub) db.assignRangeSubcategory(rangeName, sub, admin.id);
}
for (const [rangeName, , accts] of RANGES) {
  for (const n of accts) {
    db.upsertRangeRoute({
      userId: admin.id, rangeName, accountId: accounts[n].id,
      extensionEnabled: false, traderspostEnabled: true, runScheduled: false,
    });
  }
}

const mkSession = (userId: string) => {
  const token = createSessionToken();
  const csrf = createSessionToken();
  db.createSession(hashSessionToken(token, SESSION_SECRET), userId, csrf, new Date(Date.now() + 86400000).toISOString());
  return { token, csrf };
};

console.log(JSON.stringify({
  adminId: admin.id, viewerId: viewer.id,
  acct1: acct1.id, acct2: acct2.id,
  adminSession: mkSession(admin.id), viewerSession: mkSession(viewer.id),
  seededAt: new Date().toISOString(),
  runTag: process.env.PT_TAG || (process.env.PT_RUN_ID || '').replace(/-/g, '').slice(0, 8) || '',
  created, reused,
}));
db.close();
