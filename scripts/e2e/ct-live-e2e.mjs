// CrossTrade sweep-reconciliation e2e — runs inside the isolated workspace
// built by ct-run.mjs (fresh DB, mock CT receiver + REST twin on one port).
// Exercises the per-leg sweep rules against real code paths:
//   1. arm a CT entry at the mock broker (Working order, our wire id)
//   2. wipe local bookkeeping (ledger cancelled + monitor cancelled)
//   3. sweep → the live leg is adopted: ledger revived to 'acknowledged',
//      monitor re-armed, crossTradeAdoptedOrder logged
//   4. re-sweep → idempotent, no duplicate adoption
//   5. a ghost ledger row with no NT8 leg past the removal window → 'rejected'
//   6. a ledger row regressed to 'pending' re-mirrors its live leg → 'acknowledged'
//   7. ledger row purged entirely — the cancelled monitor alone carries the
//      bracket identity, adoption recreates the row with the echoed wire id
//   8. orphan arm — dead NT8 leg + all-terminal ledger → monitor retired
//   9. resend — a live '<bracket>-a1' leg revives the -a1 attempt, not the base
//  10. PartFilled — adoption goes through the fill path (ledger 'filled',
//      monitor 'filled', entry_filled journaled at broker qty)
import { createRequire } from 'node:module';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(repo, 'package.json'));
const Sqlite = require('better-sqlite3');

const BASE = process.env.PUBLIC_BASE_URL;
const SECRET = process.env.PROXY_WEBHOOK_SECRET;
const DB_PATH = process.env.PT_DB ?? process.env.DATABASE_PATH;
const db = new Sqlite(DB_PATH);
db.pragma('busy_timeout = 10000');
const TAG = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra) => {
  results.push([name, Boolean(cond)]);
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(extra)}`}`);
};

// Admin session minted straight into the sessions table.
const admin = db.prepare('SELECT id FROM users WHERE lower(email) = ?')
  .get((process.env.ADMIN_USER_EMAIL ?? '').toLowerCase());
assert.ok(admin, 'admin user missing from seeded DB');
const sessionToken = randomBytes(32).toString('base64url');
const csrfToken = randomBytes(32).toString('base64url');
db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
  createHmac('sha256', process.env.SESSION_SECRET).update(sessionToken).digest('base64url'),
  admin.id, csrfToken,
  new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString(),
);

const proxy = async (payload) => {
  const res = await fetch(`${BASE}/proxy/${SECRET}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const sweep = async () => {
  const res = await fetch(`${BASE}/app/debugging/ct-sweep-now`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `bridge_session=${sessionToken}` },
    body: JSON.stringify({ csrfToken }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const mockState = async () => (await fetch(`${BASE}/mock/crosstrade/state`)).json();

const ctAccount = db.prepare("SELECT id FROM accounts WHERE name = 'E2E-CT-MOCK'").get();
assert.ok(ctAccount, 'E2E-CT-MOCK account missing — seed did not run');

const RANGE = 'SIM-CT-MGC';
const TICKER = 'MGC1!';
const rawBracket = `e2e-adopt-${TAG}`;
// scopePayloadIdsToRange prefixes the stored range slug — rows key on the
// scoped id, so match by suffix.
const findLedger = () => db.prepare(
  "SELECT * FROM broker_orders WHERE account_id = ? AND bracket_id LIKE ? AND action = 'buy' ORDER BY created_at DESC",
).all(ctAccount.id, `%${rawBracket}%`);
const findMonitor = () => db.prepare(
  'SELECT * FROM bracket_monitor WHERE account_id = ? AND bracket_id LIKE ?',
).all(ctAccount.id, `%${rawBracket}%`);
const adoptedLogs = () => db.prepare(
  "SELECT COUNT(*) AS n FROM bridge_logs WHERE data_json LIKE ?",
).get(`%"crossTradeAdoptedOrder"%${rawBracket}%`).n;

// --- Phase 1: live arm at the mock broker -----------------------------------
console.log('\n=== arm SIM-CT-MGC long — CT place lands at mock ===');
const entry = 2390;
const orderRes = await proxy({
  ticker: TICKER, action: 'buy', orderType: 'stop', stopPrice: entry,
  quantity: 1, quantityType: 'fixed_quantity',
  bracketId: rawBracket, tradeId: rawBracket, bracketSide: 'long',
  takeProfit: { limitPrice: entry + 4 },
  stopLoss: { type: 'stop', stopPrice: entry - 2 },
  extras: { rangeName: RANGE },
});
const armRes = await proxy({
  eventType: 'entry_armed', eventId: `arm-${rawBracket}`, tradeId: rawBracket,
  ticker: TICKER, side: 'long', action: 'buy', orderType: 'stop',
  entryPrice: entry, stopPrice: entry, quantity: 1,
  occurredAt: new Date().toISOString(), extras: { rangeName: RANGE },
});
check('order accepted', orderRes.status === 202, orderRes);
check('arm accepted', armRes.status === 202, armRes);
await sleep(1500);

let ledger = findLedger();
let monitor = findMonitor();
check('ledger row dispatched', ledger.length > 0, ledger);
check('monitor armed', monitor[0]?.state === 'armed', monitor[0]?.state);
const mockOrders = (await mockState()).books?.flatMap((b) => b.orders ?? []) ?? [];
const liveLeg = mockOrders.find((o) => o.orderId?.includes(rawBracket) && o.state === 'Working');
check('mock book shows the Working leg', Boolean(liveLeg), mockOrders.map((o) => [o.orderId, o.state]));

// --- Phase 2: lose the bookkeeping ------------------------------------------
console.log('\n=== wipe tracking (ledger cancelled, monitor cancelled) ===');
db.prepare("UPDATE broker_orders SET status = 'cancelled', status_source = 'bridge' WHERE id = ?").run(ledger[0].id);
db.prepare("UPDATE bracket_monitor SET state = 'cancelled' WHERE account_id = ? AND bracket_id LIKE ?")
  .run(ctAccount.id, `%${rawBracket}%`);
check('ledger now cancelled', findLedger()[0]?.status === 'cancelled');
check('monitor now cancelled', findMonitor()[0]?.state === 'cancelled');

// --- Phase 3: sweep adopts the live leg --------------------------------------
console.log('\n=== sweep: adopt the live NT8 leg ===');
const sweepRes = await sweep();
check('sweep 200', sweepRes.status === 200, sweepRes);
ledger = findLedger();
monitor = findMonitor();
check('ledger revived to acknowledged', ledger[0]?.status === 'acknowledged', ledger[0]?.status);
check('ledger source is bridge', ledger[0]?.status_source === 'bridge', ledger[0]?.status_source);
check('monitor re-armed', monitor[0]?.state === 'armed', monitor[0]?.state);
check('adoption logged', adoptedLogs() >= 1);

// --- Phase 4: re-sweep is a no-op ---------------------------------------------
console.log('\n=== re-sweep: idempotent, no double adoption ===');
const before = adoptedLogs();
await sweep();
check('no duplicate adoption', adoptedLogs() === before, adoptedLogs());

// --- Phase 4b: covered-but-armless — ledger open, monitor cancelled ----------
console.log('\n=== covered arm: open ledger + live leg heals a cancelled monitor ===');
db.prepare("UPDATE bracket_monitor SET state = 'cancelled' WHERE account_id = ? AND bracket_id LIKE ?")
  .run(ctAccount.id, `%${rawBracket}%`);
await sweep();
check('covered arm re-armed by leg sync', findMonitor()[0]?.state === 'armed', findMonitor()[0]?.state);
check('no extra adoption logged for covered arm', adoptedLogs() === before, adoptedLogs());

// --- Phase 5: absent-past-window removal --------------------------------------
console.log('\n=== ghost row: acknowledged but absent past removal window ===');
const ghostId = `e2e-ghost-${TAG}`;
db.prepare(
  `INSERT INTO broker_orders (id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity, destination, occurred_at, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, 'buy', 'acknowledged', ?, 'long', 1, 'crosstrade', ?, ?, ?)`,
).run(randomUUID(), ctAccount.id, RANGE, ghostId, ghostId, TICKER,
  new Date(Date.now() - 10 * 60_000).toISOString(), new Date().toISOString(), new Date().toISOString());
await sweep();
const ghost = db.prepare('SELECT status, error_text FROM broker_orders WHERE order_id = ?').get(ghostId);
check('ghost row removed as rejected', ghost?.status === 'rejected', ghost);
check('rejection cites absence', /absent|not found/i.test(ghost?.error_text ?? ''), ghost?.error_text);

// --- Phase 6: regressed row re-mirrors its live leg ----------------------------
console.log('\n=== leg sync: pending row mirrors Working NT8 leg ===');
const liveRow = findLedger()[0];
db.prepare("UPDATE broker_orders SET status = 'pending', status_source = 'dispatch' WHERE id = ?").run(liveRow.id);
await sweep();
const resynced = db.prepare('SELECT status FROM broker_orders WHERE id = ?').get(liveRow.id);
check('pending row re-acknowledged from book', resynced?.status === 'acknowledged', resynced);

// --- Phase 7: ledger purged entirely — cancelled monitor alone revives it ----
console.log('\n=== wipe again, harder: DELETE the ledger row (purge simulation) ===');
const liveRowId = db.prepare('SELECT id FROM broker_orders WHERE id = ?').get(liveRow.id)?.id;
db.prepare('DELETE FROM broker_orders WHERE id = ?').run(liveRowId);
db.prepare("UPDATE bracket_monitor SET state = 'cancelled' WHERE account_id = ? AND bracket_id LIKE ?")
  .run(ctAccount.id, `%${rawBracket}%`);
check('ledger row gone', findLedger().length === 0);
check('monitor cancelled again', findMonitor()[0]?.state === 'cancelled');
await sweep();
const recreated = findLedger();
check('adoption recreated the row', recreated[0]?.status === 'acknowledged', recreated);
check('recreated row carries the echoed wire id', recreated[0]?.order_id?.includes(rawBracket), recreated[0]?.order_id);
check('monitor re-armed again', findMonitor()[0]?.state === 'armed', findMonitor()[0]?.state);

// --- Phase 8: orphan arm — dead leg + all-terminal ledger → arm retires -----
console.log('\n=== orphan arm: dead leg + terminal ledger, sweep retires it ===');
const orphan = `e2e-orphan-${TAG}`;
const armMonitor = async (bracket, ticker, range, side, entryPrice, qty = 1) => {
  await proxy({
    ticker, action: side === 'long' ? 'buy' : 'sell', orderType: 'stop', stopPrice: entryPrice,
    quantity: qty, quantityType: 'fixed_quantity', bracketId: bracket, tradeId: bracket, bracketSide: side,
    extras: { rangeName: range },
  });
  await proxy({
    eventType: 'entry_armed', eventId: `arm-${bracket}`, tradeId: bracket,
    ticker, side, action: side === 'long' ? 'buy' : 'sell', orderType: 'stop',
    entryPrice, stopPrice: entryPrice, quantity: qty,
    occurredAt: new Date().toISOString(), extras: { rangeName: range },
  });
  await sleep(1200);
};
const monFor = (bracket) => db.prepare(
  'SELECT * FROM bracket_monitor WHERE account_id = ? AND bracket_id LIKE ?',
).all(ctAccount.id, `%${bracket}%`);
const ledFor = (bracket) => db.prepare(
  "SELECT * FROM broker_orders WHERE account_id = ? AND bracket_id LIKE ? ORDER BY created_at DESC",
).all(ctAccount.id, `%${bracket}%`);
const mockCmd = (payload) => fetch(`${BASE}/mock/crosstrade`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
}).then((r) => r.json().catch(() => ({})));

await armMonitor(orphan, 'MNQ1!', 'SIM-CT-MNQ', 'long', 29500);
check('orphan leg live at mock', Boolean((await mockState()).books?.flatMap((b) => b.orders ?? []).find((o) => o.orderId?.includes(orphan) && o.state === 'Working')));
// Broker cancels it, and the ledger is already terminal — only the orphan
// rule can retire the arm (leg sync iterates open rows only).
await mockCmd({ command: 'cancelorders', account: 'Sim101', instrument: 'MNQ1!' });
db.prepare("UPDATE broker_orders SET status = 'cancelled', status_source = 'bridge' WHERE account_id = ? AND bracket_id LIKE ?").run(ctAccount.id, `%${orphan}%`);
await sweep();
const orphanMon = monFor(orphan)[0];
check('orphaned arm retired', orphanMon?.state === 'cancelled', orphanMon?.state);
check('retire cites sweep evidence', String(orphanMon?.last_event_id ?? '').startsWith('ct-sweep-orphan-'), orphanMon?.last_event_id);

// --- Phase 9: adoption revives the exact wire attempt (-a1), not the base ---
console.log('\n=== resend adoption: live -a1 leg revives the -a1 attempt only ===');
const resend = `e2e-resend-${TAG}`;
await armMonitor(resend, 'MNQ1!', 'SIM-CT-MNQ', 'long', 29400);
const baseRow = ledFor(resend)[0];
assert.ok(baseRow, 'resend base row missing');
const scoped = baseRow.order_id;
// NT8 burns the used wire id; the resend went out as <bracket>-a1.
await mockCmd({ command: 'cancelorders', account: 'Sim101', instrument: 'MNQ1!' });
await mockCmd({ command: 'place', account: 'Sim101', instrument: 'MNQ1!', action: 'buy', qty: 1, order_type: 'stopmarket', stop_price: 29400, order_id: `${scoped}-a1`, oco_id: `${scoped}-a1` });
// Wipe tracking: monitor cancelled; ledger holds the cancelled base AND a
// cancelled -a1 attempt. The live leg must revive only the -a1 row.
db.prepare("UPDATE bracket_monitor SET state = 'cancelled' WHERE account_id = ? AND bracket_id LIKE ?").run(ctAccount.id, `%${resend}%`);
db.prepare("UPDATE broker_orders SET status = 'cancelled', status_source = 'bridge' WHERE id = ?").run(baseRow.id);
db.prepare(
  `INSERT INTO broker_orders (id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity, destination, occurred_at, created_at, updated_at)
   VALUES (?, ?, 'SIM-CT-MNQ', ?, ?, 'buy', 'cancelled', 'MNQ1!', 'long', 1, 'crosstrade', ?, ?, ?)`,
).run(randomUUID(), ctAccount.id, scoped, `${scoped}-a1`, baseRow.occurred_at, new Date().toISOString(), new Date().toISOString());
await sweep();
const a1Row = db.prepare('SELECT * FROM broker_orders WHERE order_id = ?').get(`${scoped}-a1`);
const baseAfter = db.prepare('SELECT * FROM broker_orders WHERE id = ?').get(baseRow.id);
check('resend attempt revived to acknowledged', a1Row?.status === 'acknowledged', a1Row?.status);
check('base attempt left cancelled', baseAfter?.status === 'cancelled', baseAfter?.status);
check('monitor re-armed via resend', monFor(resend)[0]?.state === 'armed', monFor(resend)[0]?.state);

// --- Phase 10: PartFilled leg adopts through the fill path -------------------
console.log('\n=== PartFilled adoption: ledger filled + monitor filled ===');
const partial = `e2e-partial-${TAG}`;
await armMonitor(partial, 'MGC1!', 'SIM-CT-MGC', 'long', 2400, 2);
const pRow = ledFor(partial)[0];
assert.ok(pRow, 'partial entry row missing');
const fillRes = await fetch(`${BASE}/mock/crosstrade/fill`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'Sim101', orderId: pRow.order_id, qty: 1 }),
}).then((r) => r.json());
check('mock reports the partial fill', fillRes.success === true, fillRes);
db.prepare("UPDATE broker_orders SET status = 'cancelled', status_source = 'bridge' WHERE id = ?").run(pRow.id);
db.prepare("UPDATE bracket_monitor SET state = 'cancelled' WHERE account_id = ? AND bracket_id LIKE ?").run(ctAccount.id, `%${partial}%`);
await sweep();
const pAfter = db.prepare('SELECT * FROM broker_orders WHERE id = ?').get(pRow.id);
const pMon = monFor(partial)[0];
const pFill = db.prepare(
  "SELECT quantity FROM trade_events WHERE trade_id LIKE ? AND event_type = 'entry_filled'",
).get(`%${partial}%`);
check('partial-adopted ledger is filled, not acknowledged', pAfter?.status === 'filled', pAfter?.status);
check('monitor lands filled, not armed', pMon?.state === 'filled', pMon?.state);
check('entry_filled journaled at broker qty', pFill?.quantity === 1, pFill);

// --- Phase 11: phantom close — journal says closed, book still holds the position ---
console.log('\n=== phantom close: Pine close with position still open flags erroneous ===');
const phantom = `e2e-phantom-${TAG}`;
await armMonitor(phantom, 'MNQ1!', 'SIM-CT-MNQ', 'long', 29510);
const phRow = ledFor(phantom)[0];
assert.ok(phRow, 'phantom entry row missing');
await fetch(`${BASE}/mock/crosstrade/fill`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'Sim101', orderId: phRow.order_id }),
}).then((r) => r.json());
await proxy({
  eventType: 'entry_filled', eventId: `fill-${phantom}`, tradeId: phantom,
  ticker: 'MNQ1!', side: 'long', action: 'buy', entryPrice: 29510, quantity: 1,
  occurredAt: new Date().toISOString(), extras: { rangeName: 'SIM-CT-MNQ' },
});
await proxy({
  eventType: 'trade_closed', eventId: `close-${phantom}-leg-1`, tradeId: phantom,
  ticker: 'MNQ1!', side: 'long', action: 'exit', quantity: 1,
  closedAt: new Date().toISOString(), entryPrice: 29510, exitPrice: 29560,
  realizedTicks: 200, realizedDollars: 400, outcome: 'win',
  extras: { rangeName: 'SIM-CT-MNQ', exitReason: 'take_profit' },
});
await sleep(1200);
check('phantom bracket monitor closed', monFor(phantom)[0]?.state === 'closed', monFor(phantom)[0]?.state);
check('mock still holds the position', Boolean((await mockState()).books?.find((b) => (b.position?.quantity ?? 0) > 0 && String(b.book ?? '').includes('MNQ'))), (await mockState()).books?.map((b) => b.book));
await sweep();
const phClose = db.prepare(
  "SELECT * FROM trade_events WHERE trade_id LIKE ? AND event_type = 'trade_closed'",
).get(`%${phantom}%`);
check('phantom close excluded from performance', phClose?.excluded_from_performance === 1, phClose);
check('phantom close logged', db.prepare("SELECT COUNT(*) n FROM bridge_logs WHERE data_json LIKE ?").get(`%"crossTradePhantomClose"%`).n > 0);

// --- Phase 12: orphan broker position — live position with no monitor row ---
console.log('\n=== orphan position: book position with no open bracket is surfaced ===');
await mockCmd({ command: 'place', account: 'Sim101', instrument: 'MES1!', action: 'buy', order_type: 'stopmarket', qty: 1, stop_price: 9000 });
// Fill it at the mock — the order becomes a Filled book row AND nets a live
// position; the bridge never dispatched it, so BOTH orphan checks should fire.
const orphanOrderId = (await mockState()).books
  ?.flatMap((b) => b.orders)
  .filter((o) => String(o.instrument).startsWith('MES')).at(-1)?.orderId;
await fetch(`http://127.0.0.1:${process.env.BRIDGE_PORT}/mock/crosstrade/fill`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'Sim101', orderId: orphanOrderId }),
});
await sweep();
check('orphan position logged', db.prepare("SELECT COUNT(*) n FROM bridge_logs WHERE data_json LIKE ?").get(`%"crossTradeOrphanPosition"%MES%`).n > 0,
  db.prepare("SELECT data_json FROM bridge_logs WHERE data_json LIKE '%crossTradeOrphanPosition%' ORDER BY rowid DESC LIMIT 1").get()?.data_json);
// The injected MES fill has no local ledger row — the fill itself must surface.
check('orphan fill logged', db.prepare("SELECT COUNT(*) n FROM bridge_logs WHERE data_json LIKE ?").get(`%"crossTradeOrphanFill"%MES%`).n > 0,
  db.prepare("SELECT data_json FROM bridge_logs WHERE data_json LIKE '%crossTradeOrphanFill%' ORDER BY rowid DESC LIMIT 1").get()?.data_json);
// The PartFilled bracket above stayed 'filled' with no atm_strategy on the
// wire — no protection legs spawned, so the sweep should have flagged it.
check('missing ATM protection logged for unprotected fill',
  db.prepare("SELECT COUNT(*) n FROM bridge_logs WHERE data_json LIKE ?").get(`%"crossTradeAtmMissing"%`).n > 0);

// --- Phase 13: stop-only mode — a limit entry never reaches the wire ---
console.log('\n=== stop-only: limit arm is blocked before dispatch ===');
db.prepare('UPDATE range_configurations SET stop_only_entries = 1 WHERE range_name = ?').run('SIM-CT-MNQ');
const stoponly = `e2e-stoponly-${TAG}`;
await proxy({
  ticker: 'MNQ1!', action: 'buy', orderType: 'limit', limitPrice: 29500,
  quantity: 1, quantityType: 'fixed_quantity', bracketId: stoponly, tradeId: stoponly, bracketSide: 'long',
  extras: { rangeName: 'SIM-CT-MNQ' },
});
await proxy({
  eventType: 'entry_armed', eventId: `arm-${stoponly}`, tradeId: stoponly,
  ticker: 'MNQ1!', side: 'long', action: 'buy', orderType: 'limit',
  entryPrice: 29500, quantity: 1,
  occurredAt: new Date().toISOString(), extras: { rangeName: 'SIM-CT-MNQ' },
});
await sleep(1200);
const soRow = ledFor(stoponly)[0];
check('stop-only entry ledgered rejected', soRow?.status === 'rejected', soRow?.status);
check('rejection cites stop-only', String(soRow?.error_text ?? '').startsWith('stop-only range'), soRow?.error_text);
check('limit entry never reached the mock',
  !((await mockState()).books ?? []).flatMap((b) => b.orders ?? []).some((o) => String(o.orderId ?? '').includes(stoponly)));
// A blocked arm is deterministic — the retry pass must skip it, not spam sends.
const beforeCalls = (await mockState()).callCount;
await sweep();
check('blocked arm does not auto-retry', (await mockState()).callCount === beforeCalls);

// --- Phase 14: auto-retry — rejected entry resends at the original price ---
console.log('\n=== auto-retry: rejected entry resends as -a1 at original price ===');
const retryArm = `e2e-retry-${TAG}`;
await armMonitor(retryArm, 'MNQ1!', 'SIM-CT-MNQ', 'long', 29520);
const rRow = ledFor(retryArm)[0];
assert.ok(rRow, 'retry entry row missing');
// Simulate the hard rejection: ledger terminal, monitor still armed.
db.prepare("UPDATE broker_orders SET status = 'rejected', error_text = 'Order cannot be submitted: rejected' WHERE id = ?").run(rRow.id);
await mockCmd({ command: 'cancelorders', account: 'Sim101', instrument: 'MNQ1!' });
await sweep();
const retryRow = ledFor(retryArm).find((o) => o.order_id?.includes('-a1'));
check('auto-retry dispatched -a1', Boolean(retryRow), ledFor(retryArm).map((o) => `${o.order_id}:${o.status}`));
check('retry acknowledged at mock', retryRow?.status === 'acknowledged', retryRow?.status);
check('retry uses original stop price', retryRow?.stop_price === 29520, retryRow?.stop_price);
check('retry landed working at the mock',
  Boolean((await mockState()).books?.flatMap((b) => b.orders ?? []).find((o) => o.orderId?.includes('-a1') && o.state === 'Working')));

// --- Phase 15: retry window abort — >10min old rejection cancels the arm ---
console.log('\n=== retry abort: >10min rejected arm is cancelled ===');
const staleArm = `e2e-stale-${TAG}`;
await armMonitor(staleArm, 'MNQ1!', 'SIM-CT-MNQ', 'long', 29530);
const sRow = ledFor(staleArm)[0];
assert.ok(sRow, 'stale entry row missing');
const staleWhen = new Date(Date.now() - 11 * 60_000).toISOString();
db.prepare("UPDATE broker_orders SET status = 'rejected', error_text = 'rejected', occurred_at = ? WHERE id = ?").run(staleWhen, sRow.id);
// The retry window bounds the arm's cycle — backdate the arm event too so the
// rejected attempt lands inside the stale cycle, not outside it.
db.prepare("UPDATE bracket_monitor SET last_occurred_at = ? WHERE account_id = ? AND bracket_id LIKE ?").run(staleWhen, ctAccount.id, `%${staleArm}%`);
await mockCmd({ command: 'cancelorders', account: 'Sim101', instrument: 'MNQ1!' });
await sweep();
check('stale arm retired by abort', monFor(staleArm)[0]?.state === 'cancelled', monFor(staleArm)[0]?.state);
check('abort logged', db.prepare("SELECT COUNT(*) n FROM bridge_logs WHERE data_json LIKE ?").get(`%"crossTradeRetryAborted"%${staleArm}%`).n > 0);

// --- Phase 16: retry exhaustion — 3 attempts then abort, no more sends ---
console.log('\n=== retry exhaust: max attempts then abort ===');
const exhaustArm = `e2e-exhaust-${TAG}`;
await armMonitor(exhaustArm, 'MNQ1!', 'SIM-CT-MNQ', 'long', 29540);
const eRow = ledFor(exhaustArm)[0];
assert.ok(eRow, 'exhaust entry row missing');
// Simulate a history of failed dispatches: base + a1 + a2 all rejected.
// Cloning the original row preserves every required column (id, user linkage).
for (const suffix of ['-a1', '-a2']) {
  const cols = Object.keys(eRow).join(', ');
  const vals = Object.keys(eRow).map(() => '?').join(', ');
  db.prepare(`INSERT INTO broker_orders (${cols}) VALUES (${vals})`).run(
    ...Object.entries(eRow).map(([k, v]) => k === 'id' ? randomUUID() : k === 'order_id' ? `${eRow.order_id}${suffix}` : v),
  );
}
db.prepare("UPDATE broker_orders SET status = 'rejected', error_text = 'rejected' WHERE bracket_id = ?").run(eRow.bracket_id);
// A truly rejected entry has no live leg — kill the base order at the mock so
// leg sync doesn't (correctly) re-adopt it after the abort.
await mockCmd({ command: 'cancelorders', account: 'Sim101', instrument: 'MNQ1!' });
const callsBefore = (await mockState()).callCount;
await sweep();
check('exhausted arm cancelled', monFor(exhaustArm)[0]?.state === 'cancelled', monFor(exhaustArm)[0]?.state);
check('no retry sent at attempt cap', (await mockState()).callCount === callsBefore, { before: callsBefore, after: (await mockState()).callCount });

// --- Phase 16b: OCO re-pair — retrying one arm re-pairs the working sibling ---
console.log('\n=== OCO re-pair: retried arm + sibling share the fresh group ===');
// Retire the leftover retryArm monitor so MNQ has no other open bracket —
// otherwise the re-pair rightly refuses the instrument-wide cancel.
db.prepare("UPDATE bracket_monitor SET state = 'cancelled' WHERE bracket_id LIKE ?").run(`%${retryArm}%`);
await mockCmd({ command: 'cancelorders', account: 'Sim101', instrument: 'MNQ1!' });
const pair = `e2e-pair-${TAG}`;
await armMonitor(`${pair}-long`, 'MNQ1!', 'SIM-CT-MNQ', 'long', 29520);
await armMonitor(`${pair}-short`, 'MNQ1!', 'SIM-CT-MNQ', 'short', 29480);
// Both base legs Working at the mock. Mark the LONG rejected in the ledger;
// kill its mock leg — the sibling stays Working under the OLD oco group.
db.prepare("UPDATE broker_orders SET status = 'rejected', error_text = 'rejected' WHERE bracket_id = ?").run(`${pair}-long`);
await mockCmd({ command: 'cancel', account: 'Sim101', instrument: 'MNQ1!', order_id: `${pair}-long` }).catch(() => {});
await sweep();
const mnqLegs = (await mockState()).books
  ?.flatMap((b) => b.orders ?? [])
  .filter((o) => String(o.orderId ?? '').includes(pair) && o.state === 'Working');
const pairOcos = new Set((mnqLegs ?? []).map((o) => o.ocoId));
check('both retried arms working at mock', (mnqLegs ?? []).length === 2, mnqLegs?.map((o) => `${o.orderId}:${o.state}`));
check('both arms share fresh -a1 oco group', pairOcos.size === 1 && [...pairOcos][0] === `${pair}-a1`, [...pairOcos]);
check('sibling re-pair logged', db.prepare("SELECT COUNT(*) n FROM bridge_logs WHERE data_json LIKE ?").get(`%"crossTradeOcoRepaired"%${pair}%`).n > 0);

// --- Phase 17: stop-only control — limit on a normal range still dispatches ---
console.log('\n=== stop-only off: limit arm dispatches normally ===');
db.prepare('UPDATE range_configurations SET stop_only_entries = 0 WHERE range_name IN (?, ?)').run('SIM-CT-MNQ', 'SIM-CT-MGC');
const normalLimit = `e2e-normallimit-${TAG}`;
await proxy({
  ticker: 'MGC1!', action: 'buy', orderType: 'limit', limitPrice: 2400,
  quantity: 1, quantityType: 'fixed_quantity', bracketId: normalLimit, tradeId: normalLimit, bracketSide: 'long',
  extras: { rangeName: 'SIM-CT-MGC' },
});
await sleep(1200);
check('limit arm reaches mock when stop-only off',
  Boolean((await mockState()).books?.flatMap((b) => b.orders ?? []).find((o) => String(o.orderId ?? '').includes(normalLimit))));

// --- Phase 18: phantom recovery — real exit leg upgrades the flagged close ---
console.log('\n=== phantom recovery: real exit fill clears erroneous + rewrites prices ===');
// The phantom bracket's MNQ long is still open at the mock. Attach the exit
// leg the way NT8 reports it (sell stop owned by the range strategy), fill
// it, and the sweep should un-flag + re-price the journaled close.
await mockCmd({ command: 'place', account: 'Sim101', instrument: 'MNQ1!', action: 'sell', order_type: 'stopmarket', stop_price: 29545, qty: 1, order_id: `${phantom}-Stop1`, atm_strategy: 'SIM-CT-MNQ' });
await fetch(`${BASE}/mock/crosstrade/fill`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'Sim101', orderId: `${phantom}-Stop1` }),
}).then((r) => r.json());
await sweep();
const phCloseAfter = db.prepare(
  "SELECT * FROM trade_events WHERE trade_id LIKE ? AND event_type = 'trade_closed'",
).get(`%${phantom}%`);
check('phantom exclusion cleared by real exit', phCloseAfter?.excluded_from_performance === 0, phCloseAfter?.excluded_from_performance);
check('exit repriced to broker fill', phCloseAfter?.exit_price === 29545, phCloseAfter?.exit_price);
check('broker upgrade logged', db.prepare("SELECT COUNT(*) n FROM bridge_logs WHERE data_json LIKE ?").get(`%"crossTradeBrokerRealizationUpgrade"%`).n > 0);

// --- Phase 19: negative controls — no warnings where state is consistent ---
console.log('\n=== negative controls: claimed roots / armed brackets stay quiet ===');
// MGC1! position is claimed by the PartFilled bracket (monitor filled) — the
// orphan check must not fire for a root an open bracket owns.
check('no orphan warning for claimed root',
  db.prepare("SELECT COUNT(*) n FROM bridge_logs WHERE data_json LIKE ? AND data_json LIKE '%MGC%'").get('%crossTradeOrphanPosition%').n === 0);

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
