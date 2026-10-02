// Elaborate live E2E — TP reapply cycle + CT broker-authoritative journal.
// Real /proxy alerts → real bridge logic → mocks behave like NT8/TP.
import { assertCtIsolation } from './scripts/e2e/ct-network-guard.mjs';
import { createHmac, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

assertCtIsolation();
const env = process.env;
const SECRET = env.PROXY_WEBHOOK_SECRET;
const BASE = env.PUBLIC_BASE_URL;
const CT = `${BASE}/mock/crosstrade`;
const TPM = `${BASE}/mock/traderspost`;
const db = new Database(env.DATABASE_PATH); // writable — fixture config tweak in P5
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TAG = `e2e${Date.now().toString(36)}`;

const pass = [], fail = [];
const check = (n, cond, detail = '') => { (cond ? pass : fail).push(n); console.log(`${cond ? 'PASS' : 'FAIL'}  ${n}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`); };

const proxy = (p) => fetch(`${BASE}/proxy/${SECRET}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });

// Admin session minted into the DB — same trick as dev-dual-mock-run.mjs.
const dbW = new Database(env.DATABASE_PATH);
const adminUser = dbW.prepare('SELECT id FROM users WHERE email = ?').get(env.ADMIN_USER_EMAIL) ?? dbW.prepare('SELECT id FROM users ORDER BY rowid LIMIT 1').get();
const sessionToken = randomBytes(32).toString('base64url');
const csrfToken = randomBytes(32).toString('base64url');
dbW.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
  createHmac('sha256', env.SESSION_SECRET).update(sessionToken).digest('base64url'),
  adminUser.id, csrfToken, new Date(Date.now() + 3600e3).toISOString(), new Date().toISOString());
// Force one sweep pass — replaces the 60s interval waits.
const sweepNow = async () => {
  const r = await fetch(`${BASE}/app/debugging/ct-sweep-now`, {
    method: 'POST', headers: { cookie: `bridge_session=${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ csrfToken }),
  });
  if (!r.ok) console.log('  sweep-now:', r.status, await r.text());
  await sleep(500);
};
const ctClear = () => fetch(`${CT}/clear`, { method: 'POST' });
const ctTestAccountId = db.prepare(`SELECT id FROM accounts WHERE name='E2E-CT-MOCK'`).get()?.id;
const crossTradeApiTest = (input) => fetch(`${BASE}/app/debugging/crosstrade-test`, {
  method: 'POST',
  headers: { cookie: `bridge_session=${sessionToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ accountId: ctTestAccountId, csrfToken, ...input }),
});
const ctFill = async (account, bracketId) => {
  const state = await (await fetch(`${CT}/state`)).json();
  const orders = (state.books ?? []).flatMap((b) => b.workingOrders ?? []);
  const ordersForBracket = (suffix = '') => orders.filter((o) =>
    String(o.orderId ?? '').startsWith(`${bracketId}-a`) || (suffix && String(o.ocoId ?? '') === suffix));
  // OCO pairing removes the side token; distinguish legs by order action.
  const longs = ordersForBracket().filter((o) => o.action === 'buy');
  const shorts = ordersForBracket().filter((o) => o.action === 'sell');
  const candidates = ordersForBracket(bracketId.replace(/-(long|short)(?=-|$)/, ''));
  const order = candidates.find((o) => String(o.orderId).includes(bracketId))
    ?? candidates.find((o) => o.action === 'sell' && shorts.length === 1)
    ?? candidates.find((o) => o.action === 'buy' && longs.length === 1)
    ?? candidates[0];
  const r = await fetch(`${CT}/fill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account, orderId: order?.orderId ?? bracketId }) });
  if (!r.ok) throw new Error(`ct fill failed ${r.status} ${await r.text()} for ${bracketId} -> ${order?.orderId}`);
};
const ctFlatten = (account, instrument, exitPrice) => fetch(CT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'flatten', account, instrument, exit_price: exitPrice }) });
const tpCalls = async () => (await fetch(`${TPM}/calls`)).json();

const entry = (range, ticker, side, bracketId, entryPx) => ({
  ticker, action: side === 'long' ? 'buy' : 'sell', orderType: 'stop',
  stopPrice: entryPx, quantity: 1, quantityType: 'fixed_quantity',
  bracketId, tradeId: bracketId, bracketSide: side,
  extras: { rangeName: range },
});
const arm = (range, ticker, side, bracketId, px) => ({
  eventType: 'entry_armed', eventId: `arm-${bracketId}`, tradeId: bracketId,
  ticker, side, action: side === 'long' ? 'buy' : 'sell', orderType: 'stop',
  entryPrice: px, stopPrice: px, quantity: 1, occurredAt: new Date().toISOString(), extras: { rangeName: range },
});
const fillEvt = (range, ticker, side, bracketId, px) => ({
  eventType: 'entry_filled', eventId: `fill-${bracketId}`, tradeId: bracketId,
  ticker, side, action: side === 'long' ? 'buy' : 'sell', quantity: 1,
  entryPrice: px, occurredAt: new Date().toISOString(), extras: { rangeName: range },
});
const closeEvt = (range, ticker, side, tradeId, entryPx, exitPx, ticks, dollars, outcome) => ({
  eventType: 'trade_closed', eventId: `close-${tradeId}`, tradeId,
  ticker, side, quantity: 1, occurredAt: new Date().toISOString(), closedAt: new Date().toISOString(),
  entryPrice: entryPx, exitPrice: exitPx, realizedTicks: ticks, realizedDollars: dollars, outcome,
  extras: { rangeName: range, exitReason: outcome === 'win' ? 'take_profit' : 'stop_loss' },
});

const scopedId = (range, id) => `${[...range.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ')].map(c => c === '-' ? '--' : /[A-Za-z0-9]/.test(c) ? c : c.codePointAt(0) <= 0xFF ? `-${c.codePointAt(0).toString(16).toUpperCase().padStart(2,'0')}` : `-u${c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')}`).join('')}-${id}`;
const mon = (like) => db.prepare(`SELECT bracket_id, side, state, last_event_type FROM bracket_monitor WHERE bracket_id LIKE '%' || ? || '%'`).all(like);
const bos = (like) => db.prepare(`SELECT action, status, status_source, substr(error_text,1,60) err FROM broker_orders WHERE bracket_id LIKE '%' || ? || '%' ORDER BY occurred_at`).all(like);
const tes = (like) => db.prepare(`SELECT event_type, event_id, realized_ticks_cents t, realized_dollars_cents d, outcome, exit_price FROM trade_events WHERE trade_id LIKE '%' || ? || '%'`).all(like);
const res = (like) => db.prepare(`SELECT event_type, event_id, realized_ticks_cents t, exit_price FROM range_trade_events WHERE trade_id LIKE '%' || ? || '%'`).all(like);

// === startup hygiene: retire any open monitor rows from prior runs ===
await ctClear();
await fetch(`${TPM}/clear`, { method: 'POST' });
// prior-run leftovers are fixtures, not product behavior — retire them
// directly rather than simulating closes (reused tradeIds route through
// alias logic and can miss rows re-armed under new bracket ids).
db.prepare(`UPDATE bracket_monitor SET state='closed', last_event_type='trade_closed', last_event_id='e2e-cleanup', updated_at=?
  WHERE state IN ('armed','filled')
    AND (bracket_id LIKE '%-e2e-%' OR bracket_id LIKE 'e2e-%' OR bracket_id LIKE '%bridge-reapply-%' OR range_name LIKE 'SIM-%' OR range_name='Test Range')`).run(new Date().toISOString());
await sweepNow();
db.prepare(`DELETE FROM bridge_logs WHERE timestamp < ?`).run(new Date(Date.now() - 60e3).toISOString());

// ================= PHASE A: TP reapply cycle =================
console.log(`\n=== A: TP reapply cycle on SIM-TP-MNQ (E2E-TP-MOCK) ===`);
const tA = `e2e-${TAG}-tpre`;
const aLong = `${tA}-long-arm-1`, aShort = `${tA}-short-arm-1`;
// Cross-range re-arm candidate: SIM-ALL-MNQ shares MNQ + E2E-TP-MOCK route —
// its armed bracket should get an 'entry' step in the reapply op.
const aOther = `${tA}-other-short-arm-1`;
await proxy(entry('SIM-ALL-MNQ', 'MNQ1!', 'short', aOther, 29380));
await proxy(arm('SIM-ALL-MNQ', 'MNQ1!', 'short', aOther, 29380));
// distinct bracketIds per arm (Ultra convention); entries at stale levels
await proxy(entry('SIM-TP-MNQ', 'MNQ1!', 'long', aLong, 29600));
await proxy(entry('SIM-TP-MNQ', 'MNQ1!', 'short', aShort, 29400));
await proxy(arm('SIM-TP-MNQ', 'MNQ1!', 'long', aLong, 29600));
await proxy(arm('SIM-TP-MNQ', 'MNQ1!', 'short', aShort, 29400));
await sleep(2500);
let calls = (await tpCalls()).calls.filter(c => JSON.stringify(c).includes(tA));
check('A1: TP entries dispatched (pair + other-range arm)', calls.filter(c => c.payload?.action === 'buy' || c.payload?.action === 'sell').length >= 2, JSON.stringify(calls.map(c => c.payload?.action)));

// Pine fills the short, then closes it — reapply should cancel the stale long
// arm and re-place it at the close-derived level.
await proxy(fillEvt('SIM-TP-MNQ', 'MNQ1!', 'short', aShort, 29400));
await proxy(closeEvt('SIM-TP-MNQ', 'MNQ1!', 'short', aShort, 29400, 29500, -40, -20, 'loss'));
await sleep(6000);
calls = (await tpCalls()).calls.filter(c => JSON.stringify(c).includes(tA));
// reapply steps are instrument-scoped (no bracket id on the payload) — the op
// sends cancel+exit for the instrument: retire working arms + flatten residue.
const reapplied = (await tpCalls()).calls.filter(c =>
  c.payload?.ticker === 'MNQ1!' && c.payload?.extras?.reapplyOnTradeClose === true);
check('A2: reapply sent instrument-scoped cancel', reapplied.some(c => c.payload?.action === 'cancel'), reapplied.map(c => c.payload?.action).join(','));
check('A3: reapply sent flatten exit', reapplied.some(c => c.payload?.action === 'exit'), reapplied.map(c => c.payload?.action).join(','));
const mA = mon(`${tA}%`);
check('A4: short arm closed via Pine close', mA.some(r => r.side === 'short' && r.state === 'closed'), JSON.stringify(mA));
// The op's plan must contain an 'entry' step re-arming the OTHER range's
// bracket (cross-range reapply), state pending/delivered — plus per-step
// broker evidence in the ledger.
const op = db.prepare(`SELECT data_json FROM reapply_operations WHERE account_id=(SELECT id FROM accounts WHERE name='E2E-TP-MOCK') ORDER BY completed DESC, rowid DESC LIMIT 1`).get();
const steps = op ? JSON.parse(op.data_json).steps : [];
const entrySteps = steps.filter(st => st.kind === 'entry');
check('A5: reapply planned a re-arm entry step for the other range', entrySteps.length >= 1, JSON.stringify(steps.map(st => [st.kind, st.state])));
const reEntries = (await tpCalls()).calls.filter(c => JSON.stringify(c).includes('reapply') && (c.payload?.action === 'buy' || c.payload?.action === 'sell'));
check('A6: re-arm entry actually dispatched to TP', reEntries.length >= 1 || entrySteps.every(st => st.state === 'skipped'), JSON.stringify(reEntries.map(c => c.payload?.extras?.originalBracketId)));

// ================= PHASE A2: CT percent exits become exact price levels =================
console.log('\n=== A2: percent TP/SL exits become exact CT prices ===');
await ctClear();
const tPrice = `e2e-${TAG}-price`;
const priceLongId = `${tPrice}-long-arm-1`;
const priceShortId = `${tPrice}-short-arm-1`;
const percentExitEntry = (side, bracketId) => ({
  ...entry('SIM-CT-MGC', 'MGC1!', side, bracketId, 4300),
  price: 4300,
  signalPrice: 4300,
  takeProfit: { percent: 0.1 },
  stopLoss: { type: 'stop', percent: 0.06 },
});
await proxy(percentExitEntry('long', priceLongId));
await proxy(percentExitEntry('short', priceShortId));
await sleep(2500);
const priceWireCalls = (await (await fetch(`${CT}/calls`)).json()).calls
  .filter(c => c.payload?.command === 'place' && String(c.payload?.order_id ?? '').includes(tPrice));
const longPriceWire = priceWireCalls.find(c => String(c.payload.order_id).includes('price-long-arm-1'))?.payload;
const shortPriceWire = priceWireCalls.find(c => String(c.payload.order_id).includes('price-short-arm-1'))?.payload;
check('A2.1: long percent exits sent as exact tick-rounded prices (TP 4304.3, SL 4297.4)',
  longPriceWire?.take_profit === 4304.3 && longPriceWire?.stop_loss === 4297.4,
  JSON.stringify(longPriceWire && { take_profit: longPriceWire.take_profit, stop_loss: longPriceWire.stop_loss }));
check('A2.2: short percent exits sent as exact tick-rounded prices (TP 4295.7, SL 4302.6)',
  shortPriceWire?.take_profit === 4295.7 && shortPriceWire?.stop_loss === 4302.6,
  JSON.stringify(shortPriceWire && { take_profit: shortPriceWire.take_profit, stop_loss: shortPriceWire.stop_loss }));
check('A2.3: percent exits did not attach an ATM template',
  Boolean(longPriceWire && shortPriceWire) && !longPriceWire?.atm_strategy && !shortPriceWire?.atm_strategy,
  JSON.stringify({ longAtm: longPriceWire?.atm_strategy, shortAtm: shortPriceWire?.atm_strategy }));

// ================= PHASE A3: manual CrossTrade API test tick conversion =================
console.log('\n=== A3: CrossTrade API test converts tick exits before sending ===');
await ctClear();
const manualSingle = await crossTradeApiTest({
  action: 'buy', instrument: 'MGC1!', orderType: 'stop', stopPrice: 4300,
  takeProfitTicks: 40, stopLossTicks: 20, convertTicksToPrices: true,
});
const manualSingleResult = await manualSingle.json();
const manualSingleCall = (await (await fetch(`${CT}/calls`)).json()).calls[0]?.payload;
check('A3.1: manual stop order sends absolute TP/SL in CrossTrade request',
  manualSingle.ok && manualSingleResult.sent?.take_profit === 4304 && manualSingleResult.sent?.stop_loss === 4298
    && manualSingleCall?.take_profit === 4304 && manualSingleCall?.stop_loss === 4298,
  JSON.stringify({ sent: manualSingleResult.sent && { take_profit: manualSingleResult.sent.take_profit, stop_loss: manualSingleResult.sent.stop_loss }, wire: manualSingleCall && { take_profit: manualSingleCall.take_profit, stop_loss: manualSingleCall.stop_loss } }));

await ctClear();
const manualBoth = await crossTradeApiTest({
  action: 'both', instrument: 'MGC1!', stopPrice: 4300, bottomPrice: 4290,
  takeProfitTicks: 40, stopLossTicks: 20, convertTicksToPrices: true,
});
const manualBothResult = await manualBoth.json();
const manualBothCalls = (await (await fetch(`${CT}/calls`)).json()).calls.map(c => c.payload)
  .filter(p => p.instrument === 'MGC1!' && p.action && p.command === 'place');
check('A3.2: both-side API test converts each leg from its own entry level',
  manualBoth.ok
    && JSON.stringify((manualBothResult.legs ?? []).map(l => [l.sent?.take_profit, l.sent?.stop_loss])) === JSON.stringify([[4304, 4298], [4286, 4292]])
    && JSON.stringify(manualBothCalls.map(p => [p.take_profit, p.stop_loss])) === JSON.stringify([[4304, 4298], [4286, 4292]]),
  JSON.stringify({ response: (manualBothResult.legs ?? []).map(l => [l.sent?.take_profit, l.sent?.stop_loss]), wire: manualBothCalls.map(p => [p.take_profit, p.stop_loss]) }));

await ctClear();
const manualMarket = await crossTradeApiTest({
  action: 'sell', instrument: 'MGC1!', orderType: 'market', referencePrice: 4300,
  takeProfitTicks: 40, stopLossTicks: 20, convertTicksToPrices: true,
});
const manualMarketResult = await manualMarket.json();
const manualMarketCall = (await (await fetch(`${CT}/calls`)).json()).calls
  .map(c => c.payload).find(p => p.instrument === 'MGC1!' && p.action === 'sell' && p.order_type === 'market');
check('A3.3: market API test uses the supplied reference entry price',
  manualMarket.ok && manualMarketCall?.take_profit === 4296 && manualMarketCall?.stop_loss === 4302
    && manualMarketResult.sent?.take_profit === 4296 && manualMarketResult.sent?.stop_loss === 4302,
  JSON.stringify({ sent: manualMarketResult.sent && { take_profit: manualMarketResult.sent.take_profit, stop_loss: manualMarketResult.sent.stop_loss }, wire: manualMarketCall && { take_profit: manualMarketCall.take_profit, stop_loss: manualMarketCall.stop_loss } }));

// ============ PHASE EOD1: EOD-shape breakeven close -> sweep upgrades ============
// EOD/reconcile journal a $0 breakeven trade_closed (entry==exit). A later
// sweep must REPLACE it with the broker's real exit — the same upgrade path a
// Pine-first close uses, since both land in the same-day recentlyClosed set.
console.log('\n=== EOD1: breakeven flat close journaled, sweep upgrades to real P&L ===');
await ctClear();
const tE = `e2e-${TAG}-eod`;
const eShort = `${tE}-short-arm-1`, eLong = `${tE}-long-arm-1`;
await proxy(entry('SIM-CT-MNQ', 'MNQ1!', 'long', eLong, 29600));
await proxy(entry('SIM-CT-MNQ', 'MNQ1!', 'short', eShort, 29440));
await proxy(arm('SIM-CT-MNQ', 'MNQ1!', 'short', eShort, 29440));
await proxy(fillEvt('SIM-CT-MNQ', 'MNQ1!', 'short', eShort, 29440));
await sleep(2500);
await ctFill('Sim101', scopedId('SIM-CT-MNQ', eShort));
await ctFlatten('Sim101', 'MNQ1!', 29460); // broker exit: short 29440 -> 29460 = -80t
// Journal a breakeven flat close — the shape EOD/reconcile writes.
await proxy(closeEvt('SIM-CT-MNQ', 'MNQ1!', 'short', eShort, 29440, 29440, 0, 0, 'breakeven'));
await sleep(1500);
const eBefore = tes(`${eShort}%`).filter(e => e.event_type === 'trade_closed');
check('EOD1.1: breakeven $0 close journaled first', eBefore.some(e => e.t === 0 && e.outcome === 'breakeven'), JSON.stringify(eBefore));
await sweepNow();
const eAfter = tes(`${eShort}%`).filter(e => e.event_type === 'trade_closed');
check('EOD1.2: sweep upgraded close to real broker P&L (-80t @29460, no dup row)',
  eAfter.some(e => e.t === -8000 && e.exit_price === 29460 && e.outcome === 'loss') && eAfter.length === eBefore.length,
  JSON.stringify(eAfter.map(e => [e.event_id.slice(0, 28), e.t, e.exit_price])));

// ============ PHASE CXL: Pine 'filled' vs NT8 'Cancelled' -> defer, no close ============
// Monitor claims a fill while the broker's entry order is Cancelled — the
// sweep must warn and leave the row open, never synthesize a flat close.
console.log('\n=== CXL: entry order cancelled on book while monitor filled -> deferred ===');
await ctClear();
const tX = `e2e-${TAG}-cxl`;
const xShort = `${tX}-short-arm-1`, xLong = `${tX}-long-arm-1`;
await proxy(entry('SIM-CT-MGC', 'MGC1!', 'long', xLong, 4320));
await proxy(entry('SIM-CT-MGC', 'MGC1!', 'short', xShort, 4300));
await proxy(arm('SIM-CT-MGC', 'MGC1!', 'short', xShort, 4300));
await sleep(1500); // let the place land on the mock book
await proxy(fillEvt('SIM-CT-MGC', 'MGC1!', 'short', xShort, 4300)); // Pine claims a fill
await sleep(1500);
// NT8-side the entry gets cancelled (never filled) — contradicting Pine.
await fetch(CT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'cancelorders', account: 'Sim101', instrument: 'MGC1!' }) });
await sleep(500);
await sweepNow();
const xMon = mon(xShort);
const xCloses = tes(`${xShort}%`).filter(e => e.event_type === 'trade_closed');
const xDeferred = db.prepare(`SELECT data_json FROM bridge_logs WHERE data_json LIKE '%crossTradeCloseDeferred%' AND data_json LIKE '%' || ? || '%'`).all(tX);
check('CXL1: monitor row NOT closed on cancelled-entry evidence', xMon.some(r => r.side === 'short' && r.state === 'filled'), JSON.stringify(xMon));
check('CXL2: no synthetic close journaled for cancelled entry', xCloses.length === 0, JSON.stringify(xCloses));
check('CXL3: deferred-close warning ledgered', xDeferred.length >= 1, JSON.stringify(xDeferred).slice(0, 200));

// ================= PHASE B: CT — Pine closes first, CT flat replaces =================
console.log('\n=== B: CT — Pine close lands first, matched CT fill replaces ===');
await ctClear();
const tB = `e2e-${TAG}-ctb`;
const bShort = `${tB}-short-arm-1`, bLong = `${tB}-long-arm-1`;
await proxy(entry('SIM-CT-MNQ', 'MNQ1!', 'long', bLong, 29600));
await proxy(entry('SIM-CT-MNQ', 'MNQ1!', 'short', bShort, 29440));
await proxy(arm('SIM-CT-MNQ', 'MNQ1!', 'short', bShort, 29440));
// Pine reports a fractional computed entry — the broker will fill at the
// real stop price (29440), and the probe must upgrade entry_price on both
// the monitor row and the journal entry_filled event.
await proxy(fillEvt('SIM-CT-MNQ', 'MNQ1!', 'short', bShort, 29440.7777));
await sleep(2500);
await ctFill('Sim101', scopedId('SIM-CT-MNQ', bShort)); // broker fill — legs spawn, position opens
// Pine reports its own close FIRST (strategy-side numbers, wrong on purpose)
await proxy(closeEvt('SIM-CT-MNQ', 'MNQ1!', 'short', bShort, 29440, 29300, 140, 70, 'win'));
await sleep(1000);
const pineRow = tes(bShort).find(e => e.event_type === 'trade_closed');
check('B1: Pine close journaled first (+140t)', pineRow?.t === 14000, JSON.stringify(pineRow));
// Broker-side close: ATM stop exits at fill-20t = 29420 → real outcome -20t
await ctFlatten('Sim101', 'MNQ1!', 29420);
await sweepNow();
const bAfter = tes(`${bShort}%`).filter(e => e.event_type === 'trade_closed');
// short entry 29440 → exit 29420 = +20 pts = +80 ticks win (+$40)
check('B2: CT matched fill REPLACED Pine realization', bAfter.some(e => e.t === 8000 && e.exit_price === 29420 && e.outcome === 'win'), JSON.stringify(bAfter));
const bEntryTe = db.prepare(`SELECT entry_price FROM trade_events WHERE event_id = ?`).get(`${scopedId('SIM-CT-MNQ', `fill-${bShort}`)}`);
const bEntryMon = db.prepare(`SELECT entry_price, state FROM bracket_monitor WHERE bracket_id = ?`).get(scopedId('SIM-CT-MNQ', bShort));
check('B3: broker averageFillPrice upgraded Pine fractional entry (29440.78 → 29440)',
  bEntryTe?.entry_price === 29440 && bEntryMon?.entry_price === 29440,
  JSON.stringify({ tradeEvent: bEntryTe?.entry_price, monitor: bEntryMon }));

// ================= PHASE C: CT — flat close first, Pine skipped =================
console.log('\n=== C: CT flat first, Pine close arrives late → skipped ===');
await ctClear();
const tC = `e2e-${TAG}-ctc`;
const cShort = `${tC}-short-arm-1`, cLong = `${tC}-long-arm-1`;
await proxy(entry('SIM-CT-MNQ', 'MNQ1!', 'long', cLong, 29600));
await proxy(entry('SIM-CT-MNQ', 'MNQ1!', 'short', cShort, 29440));
await proxy(arm('SIM-CT-MNQ', 'MNQ1!', 'short', cShort, 29440));
await proxy(fillEvt('SIM-CT-MNQ', 'MNQ1!', 'short', cShort, 29440));
await sleep(2500);
await ctFill('Sim101', scopedId('SIM-CT-MNQ', cShort));
await ctFlatten('Sim101', 'MNQ1!', 29460); // exit above short entry → -20 pts = -80t loss
await sweepNow();
const cTe = tes(`${cShort}%`).filter(e => e.event_type === 'trade_closed');
check('C1: ct-flat synth close wrote real PnL (-80t)', cTe.some(e => e.event_id.startsWith('ct-flat-') && e.t === -8000), JSON.stringify(cTe));
// Pine's late close with different numbers — must NOT overwrite CT
await proxy(closeEvt('SIM-CT-MNQ', 'MNQ1!', 'short', cShort, 29440, 29000, 1760, 880, 'win'));
await sleep(2000);
const cAfter = tes(`${cShort}%`).filter(e => e.event_type === 'trade_closed');
check('C2: Pine close skipped — CT row unchanged (-80t, no dup)', cAfter.length === cTe.length && cAfter.every(e => e.t === -8000), JSON.stringify(cAfter.map(e => [e.event_id.slice(0, 30), e.t])));

// ================= PHASE D: re-entry after terminal bracket =================
console.log('\n=== D: same bracketId resend after close → allowed ===');
const resend = await proxy(entry('SIM-CT-MNQ', 'MNQ1!', 'short', cShort, 29440));
// fresh eventId — Ultra mints a new lifecycle eventId per arm cycle; reusing
// the phase-C eventId would dedupe and the monitor would never see it.
const cShortRearmTrade = `${cShort}-lifecycle-short-2`;
await proxy({ ...arm('SIM-CT-MNQ', 'MNQ1!', 'short', cShort, 29440), eventId: `rearm-${cShort}`, tradeId: cShortRearmTrade });
await sleep(2500);
const dDel = db.prepare(`SELECT pd.status FROM proxy_deliveries pd JOIN proxy_alerts pa ON pa.id=pd.proxy_alert_id WHERE pa.source_reference = ? ORDER BY pd.id`).all(scopedId('SIM-CT-MNQ', cShort));
check('D1: terminal bracket resend dispatched (not suppressed)', dDel.some(d => d.status === 'traderspost_delivered') && !dDel.slice(-1)[0]?.status?.startsWith('suppressed'), JSON.stringify(dDel));
const dMon = mon(cShort);
check('D2: re-armed monitor row re-opens (closed→armed on fresh arm)', dMon.some(r => r.state === 'armed'), JSON.stringify(dMon));
// NT8 burns a resolved oco_id forever — the resend must carry a fresh wire id.
const dWire = (await (await fetch(`${CT}/calls`)).json()).calls
  .filter(c => c.payload?.command === 'place' && String(c.payload?.order_id ?? '').includes('ctc-short'));
const dResent = dWire.find(c => /-a\d+$/.test(String(c.payload.order_id)));
check('D3: resend uses fresh wire id (-aN), not the burned bracket id',
  Boolean(dResent) && /-a\d+$/.test(String(dResent.payload.oco_id ?? '')),
  JSON.stringify(dWire.map(c => c.payload.order_id)));

// ================= PHASE D2: resent (-aN) bracket hydrates broker prices =================
console.log('\n=== D2: -aN resend — book match finds entry, hydrates fill + close ===');
// Pine re-arms the same bracket id (phase D); its entry_filled carries a
// fractional computed price the broker will correct. The working NT8 order is
// '<bracket>-a1' — before the wire-id fix the book match missed it and the
// entry stayed Pine-priced.
await proxy({ ...fillEvt('SIM-CT-MNQ', 'MNQ1!', 'short', cShort, 29440.9999), eventId: `refill-${cShort}`, tradeId: cShortRearmTrade });
await sleep(2500);
await ctFill('Sim101', scopedId('SIM-CT-MNQ', cShort)); // fills the -a1 working order
await ctFlatten('Sim101', 'MNQ1!', 29420); // ATM stop exits — short 29440 → +80t
await sweepNow();
const dTe = tes(`${cShort}%`).filter(e => e.event_type === 'trade_closed');
check('D4: resent bracket close synthesized from broker exit (+80t @29420)',
  dTe.some(e => e.t === 8000 && e.exit_price === 29420),
  JSON.stringify(dTe.map(e => [e.event_id.slice(0, 44), e.t, e.exit_price])));
const dEntryTe = db.prepare(`SELECT entry_price FROM trade_events WHERE event_id = ?`).get(`${scopedId('SIM-CT-MNQ', `refill-${cShort}`)}`);
const dEntryMon = db.prepare(`SELECT entry_price FROM bracket_monitor WHERE bracket_id = ?`).get(scopedId('SIM-CT-MNQ', cShort));
check('D5: broker averageFillPrice upgraded resent entry (29441 → 29440)',
  dEntryTe?.entry_price === 29440 && dEntryMon?.entry_price === 29440,
  JSON.stringify({ tradeEvent: dEntryTe?.entry_price, monitor: dEntryMon?.entry_price }));

// ================= PHASE E: ATM mismatch detector =================
console.log('\n=== E: ATM template divergence warning ===');
// mock legs are 20/40 — bump SIM-CT-MNQ's configured SL to 60 temporarily
const orig = db.prepare(`SELECT stop_loss_ticks_cents FROM range_configurations WHERE range_name='SIM-CT-MNQ'`).get();
try {
  db.prepare(`UPDATE range_configurations SET stop_loss_ticks_cents=6000 WHERE range_name='SIM-CT-MNQ'`).run();
  const tE = `e2e-${TAG}-cte`;
  const eShort = `${tE}-short-arm-1`;
  await proxy(entry('SIM-CT-MNQ', 'MNQ1!', 'short', eShort, 29440));
  await proxy(arm('SIM-CT-MNQ', 'MNQ1!', 'short', eShort, 29440));
  await proxy(fillEvt('SIM-CT-MNQ', 'MNQ1!', 'short', eShort, 29440));
  await sleep(2000);
  await ctFill('Sim101', scopedId('SIM-CT-MNQ', eShort));
  await sweepNow(); // ATM divergence check runs in the sweep while legs are Working
  const mmLog = db.prepare(`SELECT COUNT(*) c FROM bridge_logs WHERE data_json LIKE '%crossTradeAtmMismatch%' AND data_json LIKE ?`).get(`%${eShort}%`);
  check('E1: ATM mismatch logged once SL≠config', (mmLog?.c ?? 0) > 0);
} finally {
  db.prepare(`UPDATE range_configurations SET stop_loss_ticks_cents=? WHERE range_name='SIM-CT-MNQ'`).run(orig.stop_loss_ticks_cents);
}

// ================= PHASE F: journal visibility — both flavors in the UI =================
console.log('\n=== F: journal rows exist for Pine (TP) and broker (CT) ===');
const tpClose = tes(`${aShort}`).find(e => e.event_type === 'trade_closed');
check('F1: TP route journaled Pine values (-40t loss)', tpClose && tpClose.t === -4000, JSON.stringify(tpClose));
const ctClose = tes(`${cShort}`).find(e => e.event_type === 'trade_closed');
check('F2: CT route journaled broker-derived values (-80t)', ctClose && ctClose.t === -8000, JSON.stringify(ctClose));
const rangeCt = res(`${cShort}`).find(e => e.event_type === 'trade_closed');
check('F3: range journal mirrors CT close', rangeCt && rangeCt.t === -8000, JSON.stringify(rangeCt));

// cleanup: flatten the mock book + one sweep so earlier-phase monitor rows
// retire — a stale 'filled' row would otherwise defer later close synthesis
// AND block the next run's reapply (hasFilled guard). TP-side 'filled' rows
// don't sweep — send them a Pine close to retire them for real.
await ctFlatten('Sim101', 'MNQ1!');
await ctFlatten('Sim101', 'MGC1!');
await sweepNow();
db.prepare(`UPDATE bracket_monitor SET state='closed', last_event_type='trade_closed', last_event_id='e2e-cleanup', updated_at=?
  WHERE state IN ('armed','filled') AND bracket_id NOT LIKE ?
    AND (bracket_id LIKE '%-e2e-%' OR bracket_id LIKE 'e2e-%' OR bracket_id LIKE '%bridge-reapply-%' OR range_name LIKE 'SIM-%' OR range_name='Test Range')`).run(new Date().toISOString(), `%${TAG}%`);

// ================= PHASE H: per-account sizing overrides =================
console.log('\n=== H: quantity overrides per account ===');
const tpAcct = db.prepare(`SELECT id FROM accounts WHERE name='E2E-TP-MOCK'`).get();
const ctAcct = db.prepare(`SELECT id FROM accounts WHERE name='E2E-CT-MOCK'`).get();
try {
  db.prepare(`UPDATE traderspost_account_destinations SET quantity_override_mode='fixed', quantity_override_value=3 WHERE account_id=?`).run(tpAcct.id);
  db.prepare(`UPDATE traderspost_account_destinations SET quantity_override_mode='percent', quantity_override_value=200 WHERE account_id=?`).run(ctAcct.id);
  const hId = `e2e-${TAG}-size`;
  await proxy(entry('SIM-TP-MNQ', 'MNQ1!', 'long', `${hId}-long-arm-1`, 29600)); // qty 1 → fixed 3 on TP
  await sleep(2500);
  const tpQty = (await tpCalls()).calls.filter(c => JSON.stringify(c).includes(hId)).map(c => c.payload?.quantity);
  check('H1: fixed override → wire qty 3', tpQty.every(q => q === 3), JSON.stringify(tpQty));
  const hLed = db.prepare(`SELECT quantity, instrument FROM broker_orders WHERE bracket_id LIKE '%' || ? || '%'`).all(`${hId}%`);
  check('H2: ledger stores OUTBOUND qty (3) + destination instrument', hLed.every(r => r.quantity === 3), JSON.stringify(hLed));
  // CT path: percent 200 on qty 1 → 2
  await proxy(entry('SIM-CT-MNQ', 'MNQ1!', 'short', `${hId}-short-arm-1`, 29400));
  await sleep(2500);
  const ctQty = (await (await fetch(`${CT}/calls`)).json()).calls.filter(c => JSON.stringify(c).includes(hId)).map(c => c.payload?.qty);
  check('H3: percent 200 override → CT wire qty 2', ctQty.every(q => q === 2), JSON.stringify(ctQty));
} finally {
  db.prepare(`UPDATE traderspost_account_destinations SET quantity_override_mode=NULL, quantity_override_value=NULL WHERE account_id IN (?, ?)`).run(tpAcct.id, ctAcct.id);
}

// ================= PHASE G: many concurrent open trades =================
// Production shape: several ranges armed/filled at once across instruments +
// destinations. Leave these OPEN at the end so the UI shows a live board.
console.log('\n=== G: concurrent open trades across instruments/routes ===');
const gBase = `e2e-${TAG}-multi`;
const gArms = [
  // CT-routed fills (broker position open + ATM legs working)
  { range: 'SIM-CT-MNQ', ticker: 'MNQ1!', side: 'long',  px: 29650, fill: true,  ct: true },
  { range: 'SIM-CT-MGC', ticker: 'MGC1!', side: 'short', px: 4300,  fill: true,  ct: true },
  // TP-routed fills (Pine lifecycle only — no broker book)
  { range: 'SIM-TP-MNQ', ticker: 'MNQ1!', side: 'long',  px: 29700, fill: true,  ct: false },
  { range: 'SIM-TP-MGC', ticker: 'MGC1!', side: 'long',  px: 4280,  fill: false, ct: false },
  // all-route: entry on every destination at once
  // filled on the Pine/TP side; its CT order stays Working at the mock —
  // realistic divergence: Pine filled, NT8 still holding the entry.
  { range: 'SIM-ALL-MNQ', ticker: 'MNQ1!', side: 'short', px: 29300, fill: true,  ct: false },
  // an armed-only arm left working — never fills
  { range: 'SIM-CT-MNQ', ticker: 'MNQ1!', side: 'short', px: 29200, fill: false, ct: false },
];
const gIds = gArms.map((g, i) => `${gBase}-${i}-${g.side}-arm-${i}`);
for (const [i, g] of gArms.entries()) {
  const bid = gIds[i];
  await proxy(entry(g.range, g.ticker, g.side, bid, g.px));
  await proxy(arm(g.range, g.ticker, g.side, bid, g.px));
  if (g.fill) await proxy(fillEvt(g.range, g.ticker, g.side, bid, g.px));
  if (g.ct && g.fill) await ctFill('Sim101', scopedId(g.range, bid));
}
await sleep(2500);
const openRows = db.prepare(`SELECT bracket_id, side, state FROM bracket_monitor WHERE state IN ('armed','filled') AND bracket_id LIKE '%' || ? || '%'`).all(`${gBase}%`);
const filledN = openRows.filter(r => r.state === 'filled').length;
const armedN = openRows.filter(r => r.state === 'armed').length;
// SIM-ALL-MNQ arms a monitor row on all THREE routed accounts (CT+TP+EXT) → 6 filled.
check('G1: 6 filled + 2 armed monitor rows live', filledN === 6 && armedN === 2, `filled=${filledN} armed=${armedN} ` + JSON.stringify(openRows.map(r => r.state)));
const mockState = await (await fetch(`${CT}/state`)).json();
const openPos = mockState.books.filter(b => b.position).length;
check('G2: mock holds concurrent open positions (MNQ+MGC)', openPos >= 2, `${openPos} books with positions`);

// This run's trades intentionally stay OPEN for UI inspection.

console.log(`\n========================`);
console.log(`PASS: ${pass.length}  FAIL: ${fail.length}`);
if (fail.length) { console.log('FAILURES:', fail); process.exitCode = 1; }
