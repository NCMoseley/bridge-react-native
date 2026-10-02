// Drives the comprehensive dual-dispatch e2e against the LIVE dev server
// (localhost:3000): real ULTRA-shaped alert sequences through /proxy/<secret>
// for the SIM-* fixture ranges — TradersPost + CrossTrade mock receivers,
// reject/uncertain failure paths, native OCO fill simulation, live REST reads
// through a minted admin session, and operator reconcile actions.
//   node scripts/dev-dual-mock-run.mjs
import 'dotenv/config';
import { createRequire } from 'node:module';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const Sqlite = require('better-sqlite3');

const BASE = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
const SECRET = process.env.PROXY_WEBHOOK_SECRET;
if (!SECRET) throw new Error('PROXY_WEBHOOK_SECRET not set in .env');
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) throw new Error('SESSION_SECRET not set in .env');
const ADMIN_EMAIL = (process.env.ADMIN_USER_EMAIL ?? '').toLowerCase();
const DB_PATH = path.resolve(process.env.DATABASE_PATH ?? './data/bridge.sqlite');
const db = new Sqlite(DB_PATH, { readonly: true });
const dbWrite = new Sqlite(DB_PATH);
dbWrite.pragma('busy_timeout = 10000');
const TAG = Date.now().toString(36);
const RUN_START = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

const proxy = async (payload) => {
  const res = await fetch(`${BASE}/proxy/${SECRET}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

// Admin session minted straight into the sessions table — exercises the real
// authenticated Debugging endpoints, not a bypass.
const adminUser = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(ADMIN_EMAIL);
if (!adminUser) throw new Error(`admin user ${ADMIN_EMAIL} not found`);
const sessionToken = randomBytes(32).toString('base64url');
const csrfToken = randomBytes(32).toString('base64url');
dbWrite.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
  createHmac('sha256', SESSION_SECRET).update(sessionToken).digest('base64url'),
  adminUser.id, csrfToken,
  new Date(Date.now() + 60 * 60 * 1000).toISOString(), new Date().toISOString(),
);
const sessionGet = async (path_) => {
  const res = await fetch(`${BASE}${path_}`, { headers: { cookie: `bridge_session=${sessionToken}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const sessionPost = async (path_, body) => {
  const res = await fetch(`${BASE}${path_}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `bridge_session=${sessionToken}` },
    body: JSON.stringify({ ...body, csrfToken }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// SSE listener on the real event stream — captures the toast:* and log:*
// events the UI would render, so autonomous sweep notifications are verified
// end-to-end rather than assumed.
const sseEvents = [];
const sseController = new AbortController();
const ssePromise = (async () => {
  try {
    const res = await fetch(`${BASE}/app/api/events/stream`, {
      headers: { cookie: `bridge_session=${sessionToken}` },
      signal: sseController.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        const ev = /^event: (\S+)/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (ev) sseEvents.push({ event: ev, data: data ? JSON.parse(data) : {} });
      }
    }
  } catch { /* aborted at script end */ }
})();

// --- payload builders (same shapes as scripts/e2e/driver.mjs + ULTRA extras) ---
const TICK = { 'MNQ1!': 0.25, 'MGC1!': 0.1 };
const entryOrder = (range, ticker, side, bracketId, top, bottom) => {
  const tick = TICK[ticker];
  const entry = side === 'long' ? top : bottom;
  const dir = side === 'long' ? 1 : -1;
  return {
    ticker, action: side === 'long' ? 'buy' : 'sell', orderType: 'stop',
    stopPrice: entry, quantity: 1, quantityType: 'fixed_quantity',
    bracketId, tradeId: bracketId, bracketSide: side,
    takeProfit: { limitPrice: entry + dir * 40 * tick },
    stopLoss: { type: 'stop', stopPrice: entry - dir * 20 * tick },
    extras: {
      rangeName: range,
      strategyStopPrice: entry + dir * 5 * tick,
      strategyStopMode: 'breakeven_plus',
    },
  };
};
const arm = (range, ticker, side, bracketId, entry) => ({
  eventType: 'entry_armed', eventId: `arm-${bracketId}-${uid()}`, tradeId: bracketId,
  ticker, side, action: side === 'long' ? 'buy' : 'sell', orderType: 'stop',
  entryPrice: entry, stopPrice: entry, quantity: 1,
  occurredAt: new Date().toISOString(), extras: { rangeName: range },
});
const fill = (range, ticker, side, bracketId) => ({
  eventType: 'entry_filled', eventId: `fill-${bracketId}-${uid()}`, tradeId: bracketId,
  ticker, side, action: side === 'long' ? 'buy' : 'sell', quantity: 1,
  occurredAt: new Date().toISOString(), extras: { rangeName: range },
});
const cancelEvt = (range, ticker, side, bracketId) => ({
  eventType: 'entry_cancelled', eventId: `cxl-${bracketId}-${uid()}`, tradeId: bracketId,
  ticker, side, action: 'cancel', quantity: 1,
  occurredAt: new Date().toISOString(),
  extras: { rangeName: range, cancelReason: 'opposite_suppressed_after_tp' },
});
const close = (range, ticker, side, bracketId, entry, exit) => ({
  eventType: 'trade_closed', eventId: `close-${bracketId}-${uid()}`, tradeId: bracketId,
  ticker, side, quantity: 1, occurredAt: new Date().toISOString(),
  closedAt: new Date().toISOString(), entryPrice: entry, exitPrice: exit,
  realizedTicks: 40, realizedDollars: ticker === 'MNQ1!' ? 20 : 40, outcome: 'win',
  extras: { rangeName: range, exitReason: 'take_profit' },
});

const bid = (range, side) => `e2e-${range.toLowerCase()}-${side}-${TAG}`;
const LEVELS = { 'MNQ1!': { top: 29560, bottom: 29440 }, 'MGC1!': { top: 2410, bottom: 2390 } };

// --- Phase 1: arm all four core ranges, both sides ---------------------------
console.log(`\n=== arm: 4 ranges x 2 sides (tag ${TAG}) ===`);
for (const [range, ticker] of [['SIM-TP-MNQ', 'MNQ1!'], ['SIM-TP-MGC', 'MGC1!'], ['SIM-CT-MNQ', 'MNQ1!'], ['SIM-CT-MGC', 'MGC1!']]) {
  const { top, bottom } = LEVELS[ticker];
  for (const side of ['long', 'short']) {
    const bracketId = bid(range, side);
    const entry = side === 'long' ? top : bottom;
    const o = await proxy(entryOrder(range, ticker, side, bracketId, top, bottom));
    const a = await proxy(arm(range, ticker, side, bracketId, entry));
    console.log(`  ${range} ${side}: order=${o.status} arm=${a.status}`);
  }
}

// --- Phase 1b: tri-routed ranges — one alert fans out to TP + CT + EXT -----
console.log('\n=== arm: tri-routed ranges (TP + CT + EXT simultaneously) ===');
for (const [range, ticker] of [['SIM-ALL-MNQ', 'MNQ1!'], ['SIM-ALL-MGC', 'MGC1!']]) {
  const { top, bottom } = LEVELS[ticker];
  for (const side of ['long', 'short']) {
    const bracketId = bid(range, side);
    const entry = side === 'long' ? top : bottom;
    const o = await proxy(entryOrder(range, ticker, side, bracketId, top, bottom));
    const a = await proxy(arm(range, ticker, side, bracketId, entry));
    console.log(`  ${range} ${side}: order=${o.status} arm=${a.status}`);
  }
}

// --- Phase 2: failure paths — definite reject (success:false) + 5xx (uncertain)
// SIM-CT-FLK exercises the same uncertain path through the converted CT send —
// its failure toast must say "CrossTrade", not "TradersPost".
console.log('\n=== failure paths: SIM-TP-REJ (reject), SIM-TP-FLK (503), SIM-CT-FLK (503) ===');
for (const [range, ticker] of [['SIM-TP-REJ', 'MNQ1!'], ['SIM-TP-FLK', 'MGC1!'], ['SIM-CT-FLK', 'MNQ1!']]) {
  const { top } = LEVELS[ticker];
  const bracketId = bid(range, 'long');
  const o = await proxy(entryOrder(range, ticker, 'long', bracketId, top, top - 20));
  const a = await proxy(arm(range, ticker, 'long', bracketId, top));
  console.log(`  ${range} long: order=${o.status} arm=${a.status}`);
}

// --- Phase 3: fills + closes on the MNQ ranges (TP close triggers reapply) ---
console.log('\n=== fill + close: SIM-TP-MNQ long (reapply ON), SIM-CT-MNQ long ===');
for (const range of ['SIM-TP-MNQ', 'SIM-CT-MNQ']) {
  const longId = bid(range, 'long');
  const shortId = bid(range, 'short');
  await sleep(400);
  const f = await proxy(fill(range, 'MNQ1!', 'long', longId));
  const c = await proxy(cancelEvt(range, 'MNQ1!', 'short', shortId));
  const cl = await proxy(close(range, 'MNQ1!', 'long', longId, 29560, 29570));
  console.log(`  ${range}: fill=${f.status} cancel=${c.status} close=${cl.status}`);
}

await sleep(4000); // let async dispatch + reapply settle

// --- Phase 3b: full close cycles on the tri-routed ranges --------------------
// SIM-ALL-MNQ long wins; SIM-ALL-MGC short wins. On TP the closes trigger
// reapply instrument sweeps over the still-armed brackets; on CT they're
// bookkeeping-only (OCO handles the loser natively); on EXT bookkeeping-only.
console.log('\n=== close cycles: SIM-ALL-MNQ long win, SIM-ALL-MGC short win ===');
for (const [range, ticker, side, other, entry, exit] of [
  ['SIM-ALL-MNQ', 'MNQ1!', 'long', 'short', 29560, 29570],
  ['SIM-ALL-MGC', 'MGC1!', 'short', 'long', 2390, 2400],
]) {
  const winId = bid(range, side);
  const loseId = bid(range, other);
  await sleep(400);
  const f = await proxy(fill(range, ticker, side, winId));
  const c = await proxy(cancelEvt(range, ticker, other, loseId));
  const cl = await proxy(close(range, ticker, side, winId, entry, exit));
  console.log(`  ${range}: fill(${side})=${f.status} cancel(${other})=${c.status} close=${cl.status}`);
}
await sleep(4000); // reapply on the TP account needs settle time

// --- Phase 4: simulate the NT8 fill on the CT mock ---------------------------
console.log('\n=== NT8 fill simulation: CT-MNQ long (OCO sibling should die) ===');
const ctLongId = bid('SIM-CT-MNQ', 'long');
const fillRes = await fetch(`${BASE}/mock/crosstrade/fill`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: 'Sim101', orderId: ctLongId }),
});
console.log(`  fill ${ctLongId}:`, JSON.stringify(await fillRes.json()));

// --- Phase 4b: ATM policy — BE range attaches atm_strategy, no-BE range doesn't
console.log('\n=== ATM policy: BE range -> atm_strategy, no-BE range -> plain ===');
const ctCalls = (await (await fetch(`${BASE}/mock/crosstrade/calls`)).json()).calls;
const placeFor = (range, side) => ctCalls.find((c) => c.payload?.command === 'place' && c.payload?.order_id === bid(range, side));
const bePlace = placeFor('SIM-CT-MNQ', 'long');       // breakEvenEnabled=true
const plainPlace = placeFor('SIM-CT-MGC', 'long');   // breakEvenEnabled=false
const bothPlace = placeFor('SIM-ALL-MGC', 'short'); // ocoMode='both'
console.log(`  SIM-CT-MNQ (BE): atm_strategy=${bePlace?.payload?.atm_strategy ?? '—'} append_atm=${bePlace?.payload?.append_atm ?? '—'}`);
console.log(`  SIM-CT-MGC (no BE): atm_strategy=${plainPlace?.payload?.atm_strategy ?? '—'} oco_id=${plainPlace?.payload?.oco_id ?? '—'}`);
console.log(`  SIM-ALL-MGC (both sides): oco_id=${bothPlace?.payload?.oco_id ?? '—'} (expected absent)`);
if (bePlace?.payload?.atm_strategy !== 'SIM-CT-MNQ' || bePlace?.payload?.append_atm !== 'true') {
  console.log('  !! BE range missing atm_strategy — dispatch policy injection failed');
}
if (plainPlace?.payload?.atm_strategy !== undefined || plainPlace?.payload?.append_atm !== undefined) {
  console.log('  !! no-BE range carried atm fields — default must be plain');
}
if (!plainPlace?.payload?.oco_id) console.log('  !! no-BE place lost its oco_id — OCO must stay native');
if (bothPlace?.payload?.oco_id !== undefined) console.log('  !! ocoMode=both range carried oco_id — pairing must be suppressed');

// --- Phase 5: live REST reads through the Debugging endpoints ----------------
const ctAccountId = db.prepare("SELECT id FROM accounts WHERE name = 'E2E-CT-MOCK'").get()?.id;
console.log('\n=== CrossTrade REST: crosstrade-state ===');
const state = await sessionGet(`/app/debugging/crosstrade-state?accountId=${ctAccountId}`);
console.log(`  status=${state.status} nt8=${state.body.nt8Account} orders=${state.body.orders?.orders?.length ?? '?'} positions=${state.body.positions?.positions?.length ?? '?'} local=${state.body.local?.openOrders?.length ?? '?'} open dispatches, ${state.body.local?.monitorRows?.length ?? '?'} monitor rows`);
for (const o of state.body.orders?.orders ?? []) {
  console.log(`    NT8 order ${o.id} ${o.orderAction} ${o.orderType} ${o.orderState} oco=${o.ocoId ?? '—'} strat=${o.ownerStrategy?.displayName ?? '—'}`);
}
// ATM template preflight: BE-enabled ranges routed to this account must have
// their named template on NT8. Exercise both branches — seed state has all
// required templates present, then pull one and confirm it surfaces as missing.
const preflight = state.body.atmPreflight ?? {};
console.log(`  ATM templates: ${state.body.atmTemplates?.templates?.length ?? '?'} saved, required=${(preflight.required ?? []).join(',') || '—'} missing=${(preflight.missing ?? []).join(',') || 'none'}`);
if (state.body.atmTemplates?.ok !== true) throw new Error('atm-templates read failed');
if ((preflight.missing ?? []).length !== 0) throw new Error(`unexpected missing templates: ${(preflight.missing ?? []).join(',')}`);
const setMockTemplates = (templates) => fetch(`${BASE}/mock/crosstrade/templates`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templates }),
});
await setMockTemplates(['SIM-ALL-MNQ', 'SIM-ALL-MGC']);
const stateMissing = await sessionGet(`/app/debugging/crosstrade-state?accountId=${ctAccountId}`);
const missingNow = stateMissing.body.atmPreflight?.missing ?? [];
console.log(`  after removing SIM-CT-MNQ template -> missing=${missingNow.join(',') || 'none'}`);
if (!missingNow.includes('SIM-CT-MNQ')) throw new Error('expected SIM-CT-MNQ to surface as missing');
await setMockTemplates(['SIM-CT-MNQ', 'SIM-ALL-MNQ', 'SIM-ALL-MGC']);
console.log('=== CrossTrade REST: single-order lookup ===');
for (const orderId of [ctLongId, 'e2e-nonexistent']) {
  const r = await sessionGet(`/app/debugging/crosstrade-order?accountId=${ctAccountId}&orderId=${encodeURIComponent(orderId)}`);
  console.log(`  ${orderId}: http=${r.status} ok=${r.body.ok} state=${r.body.data?.order?.orderState ?? '—'} err=${r.body.error ?? '—'}`);
}

// --- Phase 5b: reconcile-from-broker on CT ledger rows -----------------------
// Two real-world uncertainty cases, exercised through the operator endpoint:
//  (a) a dispatch whose response was lost but which DID reach NT8 — flip a
//      genuinely working MGC row to uncertain; the probe must restore it.
//  (b) a dispatch that never arrived — bogus order id past the grace window,
//      covering an armed monitor row the probe must retire.
console.log('\n=== CT reconcile-from-broker ===');
const mgcRow = db.prepare(
  `SELECT order_id FROM broker_orders
   WHERE destination='crosstrade' AND status='acknowledged' AND range_name='SIM-CT-MGC' AND created_at >= ? LIMIT 1`,
).get(RUN_START);
if (mgcRow) {
  dbWrite.prepare(`UPDATE broker_orders SET status='uncertain', status_source='dispatch' WHERE order_id=?`).run(mgcRow.order_id);
}
const ghostId = `e2e-ct-ghost-${TAG}`;
const ghostOccurred = new Date(Date.now() - 10 * 60_000).toISOString();
dbWrite.prepare(
  `INSERT INTO broker_orders (id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity, destination, status_source, occurred_at, created_at, updated_at)
   VALUES (?, ?, 'SIM-CT-MGC', ?, ?, 'buy', 'uncertain', 'MGC1!', 'long', 1, 'crosstrade', 'dispatch', ?, ?, ?)`,
).run(uid(), ctAccountId, ghostId, ghostId, ghostOccurred, RUN_START, RUN_START);
dbWrite.prepare(
  `INSERT INTO bracket_monitor (account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id, entry_price, last_event_id, last_event_type, last_occurred_at, created_at, updated_at)
   VALUES (?, 'SIM-CT-MGC', ?, 'long', 'MGC1!', 'armed', 1, ?, 2410, ?, 'entry_armed', ?, ?, ?)`,
).run(ctAccountId, ghostId, ghostId, `ghost-${TAG}`, ghostOccurred, RUN_START, RUN_START);
const rec = await sessionPost('/app/debugging/reconcile-crosstrade', { accountId: ctAccountId });
console.log(`  status=${rec.status} probed=${rec.body.probed}`);
for (const o of rec.body.outcomes ?? []) {
  console.log(`    ${o.orderId} -> ${o.outcome}${o.nt8State ? ` (${o.nt8State})` : ''}${o.retiredBrackets?.length ? ` retired:${o.retiredBrackets.join(',')}` : ''}${o.error ? ` err=${o.error}` : ''}`);
}
for (const r of db.prepare(`SELECT order_id, status, status_source FROM broker_orders WHERE order_id IN (?, ?)`).all(mgcRow?.order_id ?? '—', ghostId)) {
  console.log(`    ledger ${r.order_id} -> ${r.status} (source=${r.status_source})`);
}
console.log(`    ghost monitor -> ${db.prepare(`SELECT state FROM bracket_monitor WHERE bracket_id=?`).get(ghostId)?.state}`);

// --- Phase 5c: autonomous sweep — ledger resolution + SSE toasts -------------
// Backdated uncertain rows (past the grace window): one keyed on the live MGC
// short bracket (NT8 reports Working → acknowledged + toast:success), one
// bogus bracket (not-found past grace → rejected + toast:warning + arm
// retirement). Then wait for the 60 s sweep tick and verify.
console.log('\n=== CT sweep: autonomous resolution + toasts (waiting for tick) ===');
const sweepAckId = `e2e-sweep-ack-${TAG}`;
const sweepAckBracket = bid('SIM-CT-MGC', 'short'); // Working in the mock
const sweepGhostId = `e2e-sweep-ghost-${TAG}`;
for (const [orderId, bracketId, action, side] of [
  [sweepAckId, sweepAckBracket, 'buy', 'long'],
  [sweepGhostId, sweepGhostId, 'buy', 'long'],
]) {
  dbWrite.prepare(
    `INSERT INTO broker_orders (id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity, destination, status_source, occurred_at, created_at, updated_at)
     VALUES (?, ?, 'SIM-CT-MGC', ?, ?, ?, 'uncertain', 'MGC1!', ?, 1, 'crosstrade', 'dispatch', ?, ?, ?)`,
  ).run(uid(), ctAccountId, bracketId, orderId, action, side, ghostOccurred, RUN_START, RUN_START);
}
dbWrite.prepare(
  `INSERT INTO bracket_monitor (account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id, entry_price, last_event_id, last_event_type, last_occurred_at, created_at, updated_at)
   VALUES (?, 'SIM-CT-MGC', ?, 'long', 'MGC1!', 'armed', 1, ?, 2410, ?, 'entry_armed', ?, ?, ?)`,
).run(ctAccountId, sweepGhostId, sweepGhostId, `sweep-ghost-${TAG}`, ghostOccurred, RUN_START, RUN_START);

const sweepDeadline = Date.now() + 85_000;
let ackRow, ghostRow;
while (Date.now() < sweepDeadline) {
  ackRow = db.prepare(`SELECT status, status_source, error_text FROM broker_orders WHERE order_id=?`).get(sweepAckId);
  ghostRow = db.prepare(`SELECT status, status_source, error_text FROM broker_orders WHERE order_id=?`).get(sweepGhostId);
  if (ackRow?.status === 'acknowledged' && ghostRow?.status === 'rejected') break;
  await sleep(3000);
}
console.log(`  sweep-ack -> ${ackRow?.status ?? 'unresolved'} (${ackRow?.status_source ?? '—'}); sweep-ghost -> ${ghostRow?.status ?? 'unresolved'} (${ghostRow?.status_source ?? '—'})${ghostRow?.error_text ? ` [${ghostRow.error_text}]` : ''}`);
console.log(`  ghost monitor -> ${db.prepare(`SELECT state FROM bracket_monitor WHERE bracket_id=?`).get(sweepGhostId)?.state}`);
const ctToasts = sseEvents.filter((e) => e.event.startsWith('toast:') && (String(e.data.message).includes(sweepAckId) || String(e.data.message).includes(sweepGhostId)));
for (const t of ctToasts) console.log(`  ${t.event}: ${t.data.message}`);
if (ctToasts.length < 2) console.log(`  !! expected toast:success for ${sweepAckId} and toast:warning for ${sweepGhostId} — captured ${ctToasts.length}`);
const ctFailToast = sseEvents.find((e) => e.event === 'toast:error' && String(e.data.message).startsWith('CrossTrade failed'));
console.log(`  CT failure toast (dispatch-time): ${ctFailToast ? `"${ctFailToast.data.message}"` : '!! MISSING — no CrossTrade-labelled failure toast captured'}`);
const ctLogs = db.prepare(`SELECT data_json FROM bridge_logs WHERE category='crosstrade' AND timestamp >= ?`).all(RUN_START);
console.log(`  crosstrade bridge_logs this run: ${ctLogs.length}`);
for (const l of ctLogs) console.log(`    ${JSON.parse(l.data_json).message}`);

// --- Phase 5d: extension-only path — drafts created, acted on ----------------
console.log('\n=== extension-only: drafts on E2E-EXT ===');
const draftsRes = await sessionGet('/app/api/drafts?status=pending');
const extAccountId = db.prepare("SELECT id FROM accounts WHERE name='E2E-EXT'").get()?.id;
const extDrafts = (draftsRes.body.drafts ?? []).filter((d) => d.accountId === extAccountId);
console.log(`  pending drafts on E2E-EXT: ${extDrafts.length}`);
for (const d of extDrafts) console.log(`    ${d.id} ${d.action} ${d.ticker} bracket=${d.bracketId ?? '—'}`);
// Exercise both draft actions: submit the first, mark the second reviewed.
for (const [i, action] of [[0, 'submitted'], [1, 'reviewed']]) {
  const d = extDrafts[i];
  if (!d) continue;
  const r = await sessionPost(`/app/api/drafts/${d.id}/${action}`, {});
  console.log(`  draft ${d.id.slice(0, 8)} ${action} -> ${r.status}`);
}

// --- Phase 6: operator reconcile on the failure-path rows --------------------
console.log('\n=== reconcile: retire arm + dismiss on rejected/uncertain rows ===');
const failedRows = db.prepare(
  `SELECT order_id, status, range_name FROM broker_orders
   WHERE created_at >= ? AND range_name IN ('SIM-TP-REJ', 'SIM-TP-FLK', 'SIM-CT-FLK') ORDER BY created_at`,
).all(RUN_START);
for (const row of failedRows) {
  const retire = await sessionPost('/app/debugging/reconcile-broker-order', { orderId: row.order_id, retireArm: true });
  console.log(`  ${row.range_name} ${row.order_id} [${row.status}] retireArm -> ${retire.status} ${JSON.stringify(retire.body)}`);
  if (row.status === 'uncertain' || row.status === 'pending' || row.status === 'acknowledged') {
    const mark = await sessionPost('/app/debugging/reconcile-broker-order', { orderId: row.order_id, status: 'cancelled', note: 'e2e cleanup' });
    console.log(`    mark cancelled -> ${mark.status}`);
  }
  const dismiss = await sessionPost('/app/debugging/reconcile-broker-order', { orderId: row.order_id, dismiss: true });
  console.log(`    dismiss -> ${dismiss.status} ${JSON.stringify(dismiss.body)}`);
}

// --- Report -------------------------------------------------------------------
console.log('\n=== broker_orders this run ===');
const orders = db.prepare(
  `SELECT destination, action, status, instrument, range_name, bracket_id, error_text
   FROM broker_orders WHERE created_at >= ? ORDER BY created_at`,
).all(RUN_START);
for (const o of orders) console.log(`  [${o.destination}] ${o.action} ${o.instrument} ${o.range_name} -> ${o.status}${o.error_text ? ` (${o.error_text})` : ''}`);

console.log('\n=== bracket_monitor states ===');
const monitors = db.prepare(
  `SELECT account_id, range_name, bracket_id, side, state FROM bracket_monitor
   WHERE created_at >= ? ORDER BY range_name, side`,
).all(RUN_START);
for (const m of monitors) console.log(`  ${m.range_name} ${m.side} -> ${m.state}`);

console.log('\n=== trade_events this run ===');
const events = db.prepare(
  `SELECT range_name, event_type, side, instrument FROM trade_events WHERE occurred_at >= ? ORDER BY occurred_at`,
).all(RUN_START);
for (const e of events) console.log(`  ${e.range_name} ${e.event_type} ${e.side} ${e.instrument}`);

console.log('\n=== deliveries this run ===');
const deliveries = db.prepare(
  `SELECT d.status, a.payload_json FROM proxy_deliveries d JOIN proxy_alerts a ON a.id = d.proxy_alert_id
   WHERE d.created_at >= ? ORDER BY d.created_at`,
).all(RUN_START);
const statusCounts = {};
for (const d of deliveries) statusCounts[d.status] = (statusCounts[d.status] ?? 0) + 1;
console.log('  ' + Object.entries(statusCounts).map(([k, v]) => `${k}:${v}`).join('  '));

const tpCalls = await (await fetch(`${BASE}/mock/traderspost/calls`)).json();
const ctState = await (await fetch(`${BASE}/mock/crosstrade/state`)).json();
console.log(`\n=== mock calls ===\n  traderspost: ${tpCalls.calls.length}  crosstrade: ${ctState.callCount}`);
console.log('\n=== CT mock books (as NT8 would report) ===');
for (const book of ctState.books) {
  console.log(`  ${book.book}: position=${JSON.stringify(book.position)} working=${book.workingOrders.length}`);
  for (const o of book.orders) console.log(`    ${o.orderId} ${o.action} ${o.orderType} -> ${o.state}${o.ocoId ? ` oco=${o.ocoId}` : ''}`);
}
const tpState = await (await fetch(`${BASE}/mock/traderspost/state`)).json();
console.log('\n=== TP mock state ===');
for (const s of tpState.tickers ?? []) {
  console.log(`  ${s.ticker}: position=${JSON.stringify(s.position)} working=${s.workingOrders.length} last=${s.lastAction ?? '—'}`);
  for (const o of s.workingOrders) console.log(`    ${o.bracketId ?? '—'} ${o.action} ${o.orderType} @ ${o.stopPrice ?? o.price ?? '—'}`);
}

// --- Cross-account sync report ------------------------------------------------
// The tri-routed ranges must show IDENTICAL lifecycle bookkeeping on all three
// accounts — only the delivery surface (broker_orders / drafts) may differ.
console.log('\n=== SYNC: tri-routed ranges across TP / CT / EXT ===');
const triAccountIds = {
  TP: db.prepare("SELECT id FROM accounts WHERE name='E2E-TP-MOCK'").get()?.id,
  CT: db.prepare("SELECT id FROM accounts WHERE name='E2E-CT-MOCK'").get()?.id,
  EXT: db.prepare("SELECT id FROM accounts WHERE name='E2E-EXT'").get()?.id,
};
const monitorMap = {};
for (const [label, aid] of Object.entries(triAccountIds)) {
  const rows = db.prepare(
    `SELECT range_name, bracket_id, side, state FROM bracket_monitor
     WHERE account_id=? AND range_name LIKE 'SIM-ALL-%' ORDER BY range_name, side`,
  ).all(aid);
  monitorMap[label] = JSON.stringify(rows.map((r) => [r.range_name, r.bracket_id, r.side, r.state]));
  console.log(`  ${label} monitor:`);
  for (const r of rows) console.log(`    ${r.range_name} ${r.side} -> ${r.state}`);
}
// CT and EXT must be strictly identical — both are pure Pine bookkeeping.
// TP legitimately diverges: its closes fire reapply, which retires swept arms
// and writes rearm replacement monitor rows (bridge-reapply bracket ids).
console.log(`  monitor parity CT==EXT: ${monitorMap.CT === monitorMap.EXT ? 'YES' : 'NO — DIVERGED'}`);
console.log(`  TP monitor divergence (reapply artifacts expected): ${monitorMap.TP !== monitorMap.CT ? 'present' : 'none'}`);

const eventMap = {};
for (const [label, aid] of Object.entries(triAccountIds)) {
  const rows = db.prepare(
    `SELECT range_name, event_type, side FROM trade_events
     WHERE account_id=? AND range_name LIKE 'SIM-ALL-%' AND occurred_at >= ?
     ORDER BY occurred_at`,
  ).all(aid, RUN_START);
  eventMap[label] = JSON.stringify(rows.map((r) => [r.range_name, r.event_type, r.side]));
  console.log(`  ${label} trade_events: ${rows.length} (${rows.map((r) => r.event_type).join(', ')})`);
}
console.log(`  event parity CT==EXT: ${eventMap.CT === eventMap.EXT ? 'YES' : 'NO — DIVERGED'}`);
console.log(`  TP extra synthetic events (reapply/EOD-shaped): ${eventMap.TP !== eventMap.CT ? 'present' : 'none'}`);

for (const [label, aid] of Object.entries(triAccountIds)) {
  const bo = db.prepare(`SELECT destination, action, status FROM broker_orders WHERE account_id=? AND range_name LIKE 'SIM-ALL-%' AND created_at >= ?`).all(aid, RUN_START);
  console.log(`  ${label} broker_orders: ${bo.length}${bo.length ? ` [${bo.map((o) => `${o.destination}:${o.action}:${o.status}`).join(', ')}]` : ''}`);
}
for (const [label, aid] of Object.entries(triAccountIds)) {
  const dv = db.prepare(`SELECT status, COUNT(*) n FROM proxy_deliveries WHERE account_id=? AND created_at >= ? GROUP BY status`).all(aid, RUN_START);
  console.log(`  ${label} deliveries: ${dv.map((d) => `${d.status}:${d.n}`).join('  ') || 'none'}`);
}

// Journal parity via the real API — closed trades per account must match.
console.log('\n=== SYNC: journal closed trades ===');
for (const [label, aid] of Object.entries(triAccountIds)) {
  const j = await sessionGet(`/app/api/journal?account=${aid}`);
  const days = Object.values(j.body.journalDays ?? {});
  const closed = days.reduce((n, d) => n + (d.trades?.length ?? 0), 0);
  const pnl = days.reduce((n, d) => n + ((d.summary?.realizedDollarsCents ?? 0) / 100), 0);
  console.log(`  ${label}: http=${j.status} closedTrades=${closed} pnl=$${pnl.toFixed(2)}`);
}

// Open-trade parity — armed/filled monitor rows should match across accounts.
console.log('\n=== SYNC: open trades ===');
for (const [label, aid] of Object.entries(triAccountIds)) {
  const open = db.prepare(
    `SELECT range_name, side, state FROM bracket_monitor
     WHERE account_id=? AND state IN ('armed','filled') ORDER BY range_name, side`,
  ).all(aid);
  console.log(`  ${label}: ${open.length} open -> ${open.map((r) => `${r.range_name}:${r.side}:${r.state}`).join(', ') || 'none'}`);
}

sseController.abort();
await ssePromise;
db.close();
dbWrite.close();
