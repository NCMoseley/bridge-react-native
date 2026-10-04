// Live fan-out measurement on the dev server: seeds 10 users x 3 accounts all
// pointed at /mock/traderspost, routes them to one range, fires 5 real /proxy
// entry alerts, then reports per-trade dispatch span (max-min mock receivedAt)
// and the total drain time. Serial fan-out would show span ~= 30 x send-time;
// parallel lanes collapse it to ~1 x send-time.
//   npx tsx scripts/dev-fanout-test.ts [--keep]
// --keep leaves the DQ-* fixtures in the dev DB; default cleans them up.
import 'dotenv/config';
import { Database } from '../src/database.js';

const BASE = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
const SECRET = process.env.PROXY_WEBHOOK_SECRET;
if (!SECRET) throw new Error('PROXY_WEBHOOK_SECRET not set in .env');
const ADMIN_EMAIL = (process.env.ADMIN_USER_EMAIL ?? '').toLowerCase();
const KEEP = process.argv.includes('--keep');

const USERS = 10;
const ACCOUNTS_PER_USER = 3;
const TRADES = 5;
const RANGE = 'DQ-FANOUT';
const TICKER = 'MNQ1!';

const db = new Database();
const admin = db.findUserByEmail(ADMIN_EMAIL);
if (!admin) throw new Error(`Admin user ${ADMIN_EMAIL} not found`);

type Fixture = { userId: string; accountId: string };
const fixtures: Fixture[] = [];
// Reused fixtures must never be deleted — only rows this run created.
const createdUserIds: string[] = [];
const createdAccountIds: string[] = [];
const fixtureAccountIds: string[] = [];

for (let u = 0; u < USERS; u += 1) {
  const email = `dq-test-u${String(u).padStart(2, '0')}@example.test`;
  const existing = db.findUserByEmail(email);
  const user = existing ?? db.createUser(email);
  if (!existing) createdUserIds.push(user.id);
  for (let a = 0; a < ACCOUNTS_PER_USER; a += 1) {
    const name = `DQ-U${u}-A${a}`;
    const existingAccount = db.listAccounts(user.id).find((x) => x.name === name);
    const account = existingAccount ?? db.createAccount({ userId: user.id, name, startingBalanceCents: 0 });
    if (!existingAccount) createdAccountIds.push(account.id);
    fixtureAccountIds.push(account.id);
    db.upsertTradersPostAccountDestination(
      user.id, account.id, `${BASE}/mock/traderspost`,
      undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, false,
    );
    fixtures.push({ userId: user.id, accountId: account.id });
  }
}
db.createTrackedRange(RANGE, admin.id);
for (const f of fixtures) {
  db.upsertRangeRoute({ userId: f.userId, accountId: f.accountId, rangeName: RANGE, extensionEnabled: false, traderspostEnabled: true, runScheduled: false });
}

const cleanup = () => {
  if (KEEP) return;
  const tx = (db as unknown as { db: import('better-sqlite3').Database }).db;
  const del = (sql: string, ids: string[]) => {
    const stmt = tx.prepare(sql);
    for (const id of ids) stmt.run(id);
  };
  tx.exec('BEGIN');
  try {
    // Alerts feed deliveries/orders/events — delete children first, then alerts
    // (kept by id list gathered here so nothing leaks through FKs).
    const alertIds = (tx.prepare(`SELECT id FROM proxy_alerts WHERE range_name = ? OR source_reference LIKE 'dq-%'`).all(RANGE) as Array<{ id: string }>).map((r) => r.id);
    // Child-first delete order; try/catch per table so schema drift can't
    // leave the transaction half-clean.
    const tables: Array<[string, string[]]> = [
      // Children before parents: broker_orders + attempts reference
      // proxy_deliveries without ON DELETE CASCADE.
      ['DELETE FROM broker_orders WHERE account_id = ?', fixtureAccountIds],
      ['DELETE FROM proxy_delivery_attempts WHERE proxy_delivery_id NOT IN (SELECT id FROM proxy_deliveries)', ['']],
      ['DELETE FROM proxy_deliveries WHERE account_id = ?', fixtureAccountIds],
      ['DELETE FROM trade_events WHERE account_id = ?', fixtureAccountIds],
      ['DELETE FROM range_trade_events WHERE range_name = ?', [RANGE]],
      ['DELETE FROM bracket_monitor WHERE account_id = ?', fixtureAccountIds],
      ['DELETE FROM bracket_reapply_aliases WHERE bracket_id LIKE ?', ['dq-%']],
      ['DELETE FROM order_drafts WHERE account_id = ?', fixtureAccountIds],
      ['DELETE FROM proxy_alerts WHERE id = ?', alertIds],
      ['DELETE FROM range_routes WHERE account_id = ?', fixtureAccountIds],
      ['DELETE FROM traderspost_account_destinations WHERE account_id = ?', createdAccountIds],
      ['DELETE FROM sessions WHERE user_id = ?', createdUserIds],
      ['DELETE FROM accounts WHERE id = ?', createdAccountIds],
      ['DELETE FROM users WHERE id = ?', createdUserIds],
    ];
    for (const [sql, ids] of tables) {
      try { del(sql, ids); } catch { /* table/column may not exist in this schema */ }
    }
    tx.prepare('DELETE FROM tracked_ranges WHERE range_name = ?').run(RANGE);
    tx.prepare('DELETE FROM range_configurations WHERE range_name = ?').run(RANGE);
    tx.prepare('DELETE FROM range_subcategory_assignments WHERE range_name = ?').run(RANGE);
    tx.exec('COMMIT');
    console.log('cleanup: fixtures removed');
  } catch (err) {
    tx.exec('ROLLBACK');
    console.warn('cleanup failed — fixtures left in place:', err);
  }
};

try {
  await fetch(`${BASE}/mock/traderspost/clear`, { method: 'POST' }).catch(() => {});
  const runStart = Date.now();
  const spans: Array<{ trade: number; sends: number; firstMs: number; lastMs: number; spanMs: number }> = [];
  for (let trade = 1; trade <= TRADES; trade += 1) {
    const bracketId = `dq-${RANGE.toLowerCase()}-t${trade}-${Date.now().toString(36)}`;
    const res = await fetch(`${BASE}/proxy/${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ticker: TICKER,
        action: 'buy',
        bracketId,
        bracketSide: 'long',
        quantity: 1,
        quantityType: 'fixed_quantity',
        orderType: 'stop',
        stopPrice: 25000,
        takeProfit: { percent: 0.1 },
        stopLoss: { type: 'stop', percent: 0.1 },
        extras: { rangeName: RANGE },
      }),
    });
    if (res.status !== 202) {
      console.error(`trade ${trade}: proxy status ${res.status}`, await res.text());
      continue;
    }
    // /proxy acks before async dispatch drains — poll the mock until all
    // lanes' sends have been captured (or the wait times out).
    // The wire brackets are range-scoped (DQ--FANOUT-<id>) — match by suffix.
    let mine: Array<{ receivedAt: string; payload: Record<string, unknown> }> = [];
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const { calls } = await (await fetch(`${BASE}/mock/traderspost/calls`)).json() as { calls: Array<{ receivedAt: string; payload: Record<string, unknown> }> };
      mine = calls.filter((c) => String(c.payload?.bracketId ?? '').endsWith(bracketId));
      if (mine.length >= fixtures.length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const times = mine.map((c) => Date.parse(c.receivedAt));
    spans.push({
      trade,
      sends: mine.length,
      firstMs: times.length ? Math.min(...times) - runStart : 0,
      lastMs: times.length ? Math.max(...times) - runStart : 0,
      spanMs: times.length ? Math.max(...times) - Math.min(...times) : 0,
    });
  }
  const totalMs = Date.now() - runStart;
  console.log('\n=== fan-out measurement ===');
  console.log(`${USERS} users x ${ACCOUNTS_PER_USER} accounts = ${fixtures.length} destinations, ${TRADES} trades`);
  let allSends = 0;
  for (const s of spans) {
    allSends += s.sends;
    console.log(`trade ${s.trade}: ${s.sends}/${fixtures.length} sends, span ${s.spanMs}ms (first +${s.firstMs}ms, last +${s.lastMs}ms)`);
  }
  console.log(`total: ${allSends} sends in ${totalMs}ms wall clock`);
  const expected = fixtures.length * TRADES;
  if (allSends !== expected) {
    console.error(`EXPECTED ${expected} sends — got ${allSends}`);
    process.exitCode = 1;
  }
} finally {
  cleanup();
  db.close();
}
