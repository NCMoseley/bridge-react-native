// Seeds the DEV database (data/bridge.sqlite via .env) for the dual-dispatch
// e2e: two dedicated mock accounts (TradersPost + CrossTrade) and four test
// ranges routed to them. Idempotent — safe to re-run. Real accounts and
// destinations are never touched.
//   npx tsx scripts/dev-dual-mock-seed.ts
import 'dotenv/config';
import { Database } from '../src/database.js';

const BASE = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
const ADMIN_EMAIL = (process.env.ADMIN_USER_EMAIL ?? '').toLowerCase();

const db = new Database();
const admin = db.findUserByEmail(ADMIN_EMAIL);
if (!admin) throw new Error(`Admin user ${ADMIN_EMAIL} not found`);

const findOrCreateAccount = (name: string) => {
  const existing = db.listAccounts(admin.id).find((a) => a.name === name);
  if (existing) return existing;
  return db.createAccount({ userId: admin.id, name, startingBalanceCents: 0 });
};

const tpAccount = findOrCreateAccount('E2E-TP-MOCK');
const ctAccount = findOrCreateAccount('E2E-CT-MOCK');
const rejAccount = findOrCreateAccount('E2E-TP-REJECT');
const flkAccount = findOrCreateAccount('E2E-TP-FLAKY');
const extAccount = findOrCreateAccount('E2E-EXT');
const ctflkAccount = findOrCreateAccount('E2E-CT-FLAKY');

// TradersPost destination -> built-in mock receiver. eodEnabled off so the
// scheduler never fires real flatten traffic for the fixture accounts.
// reapplyOnTradeCloseEnabled ON so the close path exercises the full
// cancel-sweep + safeguard-exit + re-arm sequence.
db.upsertTradersPostAccountDestination(
  admin.id, tpAccount.id, `${BASE}/mock/traderspost`,
  undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, true,
);
// CrossTrade destination -> the flat-message mock. webhook_url is unused once
// crossTrade fields are set but the column is NOT NULL — point it at the TP mock.
// No apiToken — REST reads fall back to the secret key, matching real
// CrossTrade behavior where the single Secret Key is the Bearer token.
db.upsertTradersPostAccountDestination(
  admin.id, ctAccount.id, `${BASE}/mock/traderspost`,
  undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, false,
  { webhookUrl: `${BASE}/mock/crosstrade`, secretKey: 'mock-ct-secret', accountName: 'Sim101' },
);
// Failure-path fixtures: every dispatch to these accounts fails at the broker
// boundary — success:false rejection vs. 5xx (uncertain outcome).
db.upsertTradersPostAccountDestination(
  admin.id, rejAccount.id, `${BASE}/mock/traderspost?mode=reject`,
  undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, false,
);
db.upsertTradersPostAccountDestination(
  admin.id, flkAccount.id, `${BASE}/mock/traderspost?mode=error&status=503`,
  undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, false,
);
// CrossTrade flaky fixture: every dispatch 503s at the mock — exercises the
// converted-path uncertain outcome AND the destination-labelled failure toast.
db.upsertTradersPostAccountDestination(
  admin.id, ctflkAccount.id, `${BASE}/mock/traderspost`,
  undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, false,
  { webhookUrl: `${BASE}/mock/crosstrade?mode=error&status=503`, secretKey: 'mock-ct-secret', accountName: 'Sim101' },
);

// [rangeName, instrument, account]
const RANGES: Array<[string, string, string]> = [
  ['SIM-TP-MNQ', 'MNQ1!', tpAccount.id],
  ['SIM-TP-MGC', 'MGC1!', tpAccount.id],
  ['SIM-CT-MNQ', 'MNQ1!', ctAccount.id],
  ['SIM-CT-MGC', 'MGC1!', ctAccount.id],
  ['SIM-TP-REJ', 'MNQ1!', rejAccount.id],
  ['SIM-TP-FLK', 'MGC1!', flkAccount.id],
  ['SIM-CT-FLK', 'MNQ1!', ctflkAccount.id],
];

// SIM-CT-MNQ carries a breakeven rule → its CT entries must attach
// atm_strategy=rangeName (dispatch-site policy injection). SIM-CT-MGC has none
// → plain OCO entries with no atm fields. Asserted against mock captures.
const NO_BE_RANGES = new Set(['SIM-CT-MGC']);
for (const [rangeName, instrument, accountId] of RANGES) {
  db.createTrackedRange(rangeName, admin.id);
  const be = !NO_BE_RANGES.has(rangeName);
  db.upsertRangeConfiguration({
    rangeName, instrument, description: 'dual-dispatch e2e fixture',
    riskDollarsCents: 10_000, rangeWindow: '0000-2359', tradingSession: '',
    takeProfitStyle: 'ticks', takeProfitTicksCents: 4_000,   // 40 ticks
    stopLossStyle: 'ticks', stopLossTicksCents: 2_000,       // 20 ticks
    breakEvenEnabled: be,
    breakEvenTriggerTicksCents: be ? 1_000 : 0,              // trigger +10 ticks
    breakEvenOffsetTicksCents: be ? 500 : 0,                 // breakeven +5 ticks
    ocoMode: 'oco', stopOnlyEntries: true,
    runMonday: true, runTuesday: true, runWednesday: true, runThursday: true,
    runFriday: true, runSaturday: true, runSunday: true,
    entriesPerRange: 2,
  });
  db.upsertRangeRoute({
    userId: admin.id, rangeName, accountId,
    extensionEnabled: false, traderspostEnabled: true, runScheduled: false,
  });
  // Keep fixture ranges out of account/range performance aggregation.
  db.upsertRangeReviewFlag(rangeName, admin.id, 'test_data');
}

// Tri-routed ranges: the SAME range fans one alert out to all three delivery
// paths — TP dispatch, CT dispatch, and extension-only draft. This is the
// sync test: identical lifecycle must produce identical bookkeeping per
// account, differing only in the delivery surface.
// E2E-EXT gets no destination row at all — a real extension-only account
// doesn't configure broker dispatch.
// SIM-ALL-MGC uses ocoMode 'both' → its CT places must NOT carry oco_id
// (both arms may be live at once); SIM-ALL-MNQ keeps the default OCO pairing.
const TRI_RANGES: Array<[string, string]> = [
  ['SIM-ALL-MNQ', 'MNQ1!'],
  ['SIM-ALL-MGC', 'MGC1!'],
];
for (const [rangeName, instrument] of TRI_RANGES) {
  db.createTrackedRange(rangeName, admin.id);
  db.upsertRangeConfiguration({
    rangeName, instrument, description: 'tri-path sync e2e fixture',
    riskDollarsCents: 10_000, rangeWindow: '0000-2359', tradingSession: '',
    takeProfitStyle: 'ticks', takeProfitTicksCents: 4_000,
    stopLossStyle: 'ticks', stopLossTicksCents: 2_000,
    breakEvenEnabled: true, breakEvenTriggerTicksCents: 1_000, breakEvenOffsetTicksCents: 500,
    ocoMode: rangeName === 'SIM-ALL-MGC' ? 'both' : 'oco',
    runMonday: true, runTuesday: true, runWednesday: true, runThursday: true,
    runFriday: true, runSaturday: true, runSunday: true,
    entriesPerRange: 2,
  });
  for (const [accountId, extensionEnabled, traderspostEnabled] of [
    [tpAccount.id, false, true],
    [ctAccount.id, false, true],
    [extAccount.id, true, false],
  ] as Array<[string, boolean, boolean]>) {
    db.upsertRangeRoute({ userId: admin.id, rangeName, accountId, extensionEnabled, traderspostEnabled, runScheduled: false });
  }
  db.upsertRangeReviewFlag(rangeName, admin.id, 'test_data');
}

console.log(JSON.stringify({
  adminId: admin.id,
  tpAccount: tpAccount.id,
  ctAccount: ctAccount.id,
  rejAccount: rejAccount.id,
  flkAccount: flkAccount.id,
  extAccount: extAccount.id,
  ctflkAccount: ctflkAccount.id,
  ranges: [...RANGES.map(([r]) => r), ...TRI_RANGES.map(([r]) => r)],
}, null, 2));
db.close();
