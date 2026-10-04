// Pressure-test e2e driver. Runs real HTTP lifecycle/entry alerts against an
// isolated bridge instance and a controllable mock TradersPost, then asserts on
// the SQLite ledger, bracket monitor, reapply ops, and the mock's call log.
// Env: BRIDGE_PORT (3100), MOCK_PORT (3199), PT_WORKDIR (/tmp/pt-e2e),
//      PT_DB (<workdir>/bridge.sqlite), PROXY_WEBHOOK_SECRET, ADMIN_API_KEY.
import assert from 'node:assert/strict';
import { assertIsolation } from './isolation.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const Sqlite = require('better-sqlite3');

assertIsolation();
const WORKDIR = process.env.PT_WORKDIR;
const BRIDGE = `http://127.0.0.1:${process.env.BRIDGE_PORT}`;
const MOCK = process.env.MOCK_BASE_URL;
const SECRET = process.env.PROXY_WEBHOOK_SECRET || 'pt-secret';
const ADMIN_KEY = process.env.ADMIN_API_KEY || 'pt-admin-key-0000000000000000';
const DB_PATH = process.env.PT_DB || path.join(WORKDIR, 'bridge.sqlite');
const IDS = JSON.parse(fs.readFileSync(path.join(WORKDIR, 'ids.json'), 'utf8'));

const db = new Sqlite(DB_PATH, { readonly: true });
const SHARED = process.env.PT_E2E_LIVE === '1';
const destinations = db.prepare(`SELECT account_id, webhook_url FROM traderspost_account_destinations
  ${SHARED ? 'WHERE account_id IN (?,?)' : ''}`).all(...(SHARED ? [IDS.acct1, IDS.acct2] : []));
if (!SHARED) assert.equal(destinations.length, 2);
else assert.equal(destinations.length, 2, 'seeded PT destinations missing');
assert.ok(destinations.every(d => [IDS.acct1, IDS.acct2].includes(d.account_id)
  && [`${MOCK}/tp/a1`, `${MOCK}/tp/a2`].includes(d.webhook_url)));
if (!SHARED) assert.equal(db.prepare('SELECT COUNT(*) c FROM accounts').get().c, 2);
else assert.equal(db.prepare('SELECT COUNT(*) c FROM accounts WHERE id IN (?,?)').get(IDS.acct1, IDS.acct2).c, 2);
assert.equal((await (await fetch(`${MOCK}/__identity`)).json()).runId, process.env.PT_RUN_ID);
const sessionCheck = await fetch(`${BRIDGE}/app/api/session`, { headers: { cookie: `bridge_session=${IDS.adminSession.token}` } });
assert.equal(sessionCheck.status, 200, 'Bridge must authenticate this isolated run before any mutation');
assert.equal((await sessionCheck.json()).csrfToken, IDS.adminSession.csrf);
const results = [];
let phase = '';
const check = (name, cond, detail = '') => {
  results.push({ phase, name, ok: !!cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, timeoutMs = 30000, pollMs = 150) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await pred();
    if (v) return v;
    await sleep(pollMs);
  }
  return undefined;
};

const proxy = async (payload) => {
  // PROXY_ASYNC=0 makes the bridge answer only after dispatch drains — during
  // the outage phase, breaker cooldowns stretch that drain well past undici's
  // default headers timeout, so cap explicitly high instead.
  const res = await fetch(`${BRIDGE}/proxy/${SECRET}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const adminApi = async (p, opts = {}) => {
  const res = await fetch(`${BRIDGE}${p}`, {
    ...opts, headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const appApi = async (session, p, opts = {}) => {
  const headers = { cookie: `bridge_session=${session.token}`, ...(opts.headers || {}) };
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    opts = { ...opts, body: JSON.stringify({ ...opts.json, csrfToken: session.csrf }) };
    delete opts.json;
  }
  if (opts.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    opts = { ...opts, body: new URLSearchParams({ ...opts.form, csrfToken: session.csrf }).toString() };
    delete opts.form;
  }
  const res = await fetch(`${BRIDGE}${p}`, { redirect: 'manual', ...opts, headers });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

const mockCalls = async () =>
  ((await (await fetch(`${MOCK}/__calls`)).json()).calls).filter((c) => c.payload?.ticker);
const setMode = async (m) => (await fetch(`${MOCK}/__mode`, { method: 'POST', body: JSON.stringify(m) })).json();
const mockState = async () => (await (await fetch(`${MOCK}/__state`)).json()).tickers;
// Tell the mock a working order filled into a position so the lifecycle fill we
// post to the Bridge corresponds to real broker state — otherwise `position`
// stays null and the "flat after exit" checks prove nothing.
const BOOK = { 1: 'a1', 2: 'a2' };
const mockFill = async (acct, ticker, bracketId) =>
  (await fetch(`${MOCK}/__fill`, { method: 'POST', body: JSON.stringify({ book: BOOK[acct], ticker, bracketId }) })).json();
const callsFor = (calls, pred) => calls.filter(pred);
const q = (sql, ...args) => db.prepare(sql).all(...args);
const q1 = (sql, ...args) => db.prepare(sql).get(...args);

const A1 = IDS.acct1, A2 = IDS.acct2;
// On a shared (real) DB every global count must be scoped to the test accounts —
// real ranges, orders, and ops must be neither asserted on nor mutated.
const scopeSql = ' AND account_id IN (?,?)';
const scopeArgs = [A1, A2];
const nowIso = () => new Date().toISOString();
const uid = () => Math.random().toString(36).slice(2, 10);
// Rows created before this instant belong to earlier runs on a shared DB.
const RUN_START = nowIso();
// Run-unique suffix so bracket ids never collide with a previous run's
// delivery/lifecycle history (the entry preflight suppresses repeat ids).
const TAG = process.env.PT_TAG || (process.env.PT_RUN_ID || '').replace(/-/g, '').slice(0, 8) || uid();
console.log(`run tag: ${TAG}`);

// --- payload builders -------------------------------------------------------
const PX = { 'MNQ1!': 29500, 'MGC1!': 2400, 'NQ1!': 21000, 'ES1!': 6000 };
const entryOrder = (range, ticker, side, bracketId, opts = {}) => ({
  ticker, action: side === 'long' ? 'buy' : 'sell', orderType: 'stop',
  stopPrice: opts.stopPrice ?? PX[ticker] + (side === 'long' ? 100 : -200),
  quantity: 1, bracketId, tradeId: bracketId,
  ...(opts.bracketSide !== false ? { bracketSide: side } : {}),
  extras: { rangeName: range },
});
const arm = (range, ticker, side, bracketId) => ({
  eventType: 'entry_armed', eventId: `arm-${bracketId}-${uid()}`, tradeId: bracketId,
  ticker, side, quantity: 1, extras: { rangeName: range },
  action: side === 'long' ? 'buy' : 'sell', orderType: 'stop',
  entryPrice: PX[ticker], stopPrice: PX[ticker],
});
const fill = (range, ticker, side, bracketId) => ({
  eventType: 'entry_filled', eventId: `fill-${bracketId}-${uid()}`, tradeId: bracketId,
  ticker, side, quantity: 1, extras: { rangeName: range },
  action: side === 'long' ? 'buy' : 'sell',
});
const cancelEvt = (range, ticker, side, bracketId) => ({
  eventType: 'entry_cancelled', eventId: `cxl-${bracketId}-${uid()}`, tradeId: bracketId,
  ticker, side, quantity: 1, extras: { rangeName: range, cancelReason: 'opposite_suppressed_after_tp' },
});
const close = (range, ticker, side, bracketId, opts = {}) => ({
  eventType: 'trade_closed', eventId: `close-${bracketId}-${uid()}`, tradeId: bracketId,
  ticker, side, quantity: 1, extras: { rangeName: range, exitReason: 'take_profit' },
  closedAt: opts.closedAt ?? nowIso(),
  realizedTicks: 50, realizedDollars: 100, outcome: 'win',
  entryPrice: PX[ticker], exitPrice: opts.exitPrice ?? PX[ticker] + 100,
});

const monitor = (accountId, bracketId) =>
  q1('SELECT state FROM bracket_monitor WHERE account_id=? AND bracket_id=?', accountId, bracketId);
const ops = () => q(`SELECT id, account_id, event_id, completed, data_json FROM reapply_operations WHERE event_id LIKE ?${scopeSql}`, `%-${TAG}-%`, ...scopeArgs)
  .map((o) => ({ ...o, data: JSON.parse(o.data_json) }));

// --- ranges under test ------------------------------------------------------
const RANGES = {
  'PT-MNQ-A': { t: 'MNQ1!', accts: [A1, A2] },
  'PT-MNQ-B': { t: 'MNQ1!', accts: [A1, A2] },
  'PT-MNQ-C': { t: 'MNQ1!', accts: [A1, A2] },
  'PT-MNQ-D': { t: 'MNQ1!', accts: [A1] },
  'PT-MNQ-E': { t: 'MNQ1!', accts: [A1, A2] },
  'PT-MNQ-F': { t: 'MNQ1!', accts: [A2] },
  'PT-MGC-A': { t: 'MGC1!', accts: [A1] },
  'PT-MGC-B': { t: 'MGC1!', accts: [A1] },
  'PT-MGC-C': { t: 'MGC1!', accts: [A1] },
  'PT-MGC-D': { t: 'MGC1!', accts: [A1] },
  'PT-NQ-A':  { t: 'NQ1!',  accts: [A1] },
  'PT-NQ-B':  { t: 'NQ1!',  accts: [A2] },
  'PT-ES-A':  { t: 'ES1!',  accts: [A1] },
  'PT-ES-B':  { t: 'ES1!',  accts: [A1] },
};
const bid = (range, side) => `${range.toLowerCase()}-${side}-${TAG}`;
const wireId = (range, id) => `${[...range.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ')].map(c => c === '-' ? '--' : /[A-Za-z0-9]/.test(c) ? c : c.codePointAt(0) <= 0xFF ? `-${c.codePointAt(0).toString(16).toUpperCase().padStart(2,'0')}` : `-u${c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')}`).join('')}-${id}`;


// ============================================================================
console.log('\n=== P0: sanity ===');
phase = 'P0';
{
  const s = await appApi(IDS.adminSession, '/app/api/session');
  check('session endpoint OK', s.status === 200, `status=${s.status}`);
  const m = await setMode({ mode: 'ok' });
  check('mock control OK', m.mode === 'ok');
}

// ============================================================================
console.log('\n=== P1: mass arm — 14 ranges x 2 arms, entry orders + lifecycle ===');
phase = 'P1';
{
  // PT-MGC-C gets NO entry order (phantom arm/fill coverage). A couple of entries
  // omit bracketSide to exercise the NULL-side ledger lookup.
  const noBracketSide = new Set(['PT-MNQ-B-short', 'PT-MGC-B-short']);
  const jobs = [];
  for (const [range, cfg] of Object.entries(RANGES)) {
    for (const side of ['long', 'short']) {
      const bracketId = bid(range, side);
      if (range !== 'PT-MGC-C') {
        jobs.push(proxy(entryOrder(range, cfg.t, side, bracketId,
          { bracketSide: !noBracketSide.has(`${range}-${side}`),
            stopPrice: range === 'PT-MNQ-D' && side === 'long' ? 29400 : undefined })));
      }
      jobs.push(proxy(arm(range, cfg.t, side, bracketId)));
    }
  }
  const settled = await Promise.all(jobs);
  check('all proxy calls accepted', settled.every((r) => r.status === 202),
    `${settled.filter((r) => r.status !== 202).length} non-202`);

  const expectedDispatches =
    Object.entries(RANGES).filter(([r]) => r !== 'PT-MGC-C')
      .reduce((n, [, c]) => n + c.accts.length * 2, 0);
  const done = await waitFor(async () => {
    const n = q1(`SELECT COUNT(*) c FROM broker_orders WHERE action IN ('buy','sell') AND created_at >= ?${scopeSql}`, RUN_START, ...scopeArgs).c;
    return n >= expectedDispatches ? n : undefined;
  }, 45000);
  check(`all ${expectedDispatches} entry dispatches ledgered`, done === expectedDispatches, `got ${done}`);

  const acked = q1(`SELECT COUNT(*) c FROM broker_orders WHERE status='acknowledged' AND created_at >= ?${scopeSql}`, RUN_START, ...scopeArgs).c;
  check('all entries acknowledged', acked === expectedDispatches, `acked=${acked}`);

  const armed = q1(`SELECT COUNT(*) c FROM bracket_monitor WHERE state='armed' AND created_at >= ?${scopeSql}`, RUN_START, ...scopeArgs).c;
  const expectedArmed = Object.values(RANGES).reduce((n, c) => n + c.accts.length * 2, 0);
  check(`all ${expectedArmed} monitor rows armed`, armed === expectedArmed, `armed=${armed}`);

  const calls = await mockCalls();
  check('mock saw every dispatch', calls.length === expectedDispatches, `calls=${calls.length}`);
}

// ============================================================================
console.log('\n=== P2: fills — real (MNQ-A), phantom (MGC-C), pending real (MGC-B later) ===');
phase = 'P2';
{
  // Real fill: mark the working order filled at the broker on both books first.
  for (const acct of [1, 2]) await mockFill(acct, 'MNQ1!', wireId('PT-MNQ-A', bid('PT-MNQ-A', 'short')));
  await proxy(fill('PT-MNQ-A', 'MNQ1!', 'short', bid('PT-MNQ-A', 'short')));
  await proxy(cancelEvt('PT-MNQ-A', 'MNQ1!', 'long', bid('PT-MNQ-A', 'long')));
  // PT-MGC-C: arm exists, fill arrives, but no entry was ever dispatched.
  await proxy(fill('PT-MGC-C', 'MGC1!', 'short', bid('PT-MGC-C', 'short')));
  await proxy(cancelEvt('PT-MGC-C', 'MGC1!', 'long', bid('PT-MGC-C', 'long')));

  await waitFor(() => monitor(A1, wireId('PT-MNQ-A', bid('PT-MNQ-A', 'short')))?.state === 'filled'
    && monitor(A2, wireId('PT-MNQ-A', bid('PT-MNQ-A', 'short')))?.state === 'filled'
    && monitor(A1, wireId('PT-MGC-C', bid('PT-MGC-C', 'short')))?.state === 'filled', 10000);

  check('MNQ-A short filled on both accounts',
    monitor(A1, wireId('PT-MNQ-A', bid('PT-MNQ-A', 'short')))?.state === 'filled'
    && monitor(A2, wireId('PT-MNQ-A', bid('PT-MNQ-A', 'short')))?.state === 'filled');
  check('MNQ-A long cancelled on both accounts',
    monitor(A1, wireId('PT-MNQ-A', bid('PT-MNQ-A', 'long')))?.state === 'cancelled'
    && monitor(A2, wireId('PT-MNQ-A', bid('PT-MNQ-A', 'long')))?.state === 'cancelled');
  check('MGC-C short is phantom-filled (monitor filled, zero dispatches)',
    monitor(A1, wireId('PT-MGC-C', bid('PT-MGC-C', 'short')))?.state === 'filled'
    && q1("SELECT COUNT(*) c FROM broker_orders WHERE bracket_id=?", wireId('PT-MGC-C', bid('PT-MGC-C', 'short'))).c === 0);

  // The broker-side position must exist now or the storm's exit checks are vacuous.
  const st = await mockState();
  check('mock a1:MNQ holds a real short position after fill', st['a1:MNQ1!']?.position?.side === 'short');
  check('mock a2:MNQ holds a real short position after fill', st['a2:MNQ1!']?.position?.side === 'short');
}

// ============================================================================
console.log('\n=== P3: THE STORM — trade_closed MNQ-A triggers instrument-wide reapply ===');
phase = 'P3';
{
  const callsBefore = (await mockCalls()).length;
  // exitPrice 29500: PT-MNQ-D long stop (29400) is stale (buy <= close) -> skipped.
  const r = await proxy(close('PT-MNQ-A', 'MNQ1!', 'short', bid('PT-MNQ-A', 'short'), { exitPrice: 29500 }));
  check('close accepted', r.status === 202);

  const done = await waitFor(() => {
    const o = ops();
    return o.length >= 2 && o.every((x) => x.completed) ? o : undefined;
  }, 60000);
  check('2 reapply ops completed (one per account)', !!done,
    done ? '' : JSON.stringify(ops().map((o) => [o.data.instrument, o.completed, o.data.reason])));

  const calls = (await mockCalls()).slice(callsBefore);
  const mnq = callsFor(calls, (c) => c.payload.ticker === 'MNQ1!');
  const cancels = mnq.filter((c) => c.payload.action === 'cancel');
  const exits = mnq.filter((c) => c.payload.action === 'exit');
  const rearms = mnq.filter((c) => c.payload.action === 'buy' || c.payload.action === 'sell');
  check('2 cancels dispatched', cancels.length === 2, `${cancels.length}`);
  check('2 exits dispatched', exits.length === 2, `${exits.length}`);
  check('15 re-arms dispatched (7+8, D-long skipped)', rearms.length === 15, `${rearms.length}`);
  check('re-arms carry source=reapply', rearms.every((c) => c.payload.extras?.source === 'reapply'));

  const skippedSteps = ops().flatMap((o) => o.data.steps ?? []).filter((s) => s.state === 'skipped');
  check('stale re-arm ledgered as skipped step', skippedSteps.length === 1
    && skippedSteps[0].arm?.bracketId === wireId('PT-MNQ-D', bid('PT-MNQ-D', 'long')),
    JSON.stringify(skippedSteps.map((s) => s.arm?.bracketId)));

  const state = await mockState();
  check('mock a1:MNQ position flat after exit', !state['a1:MNQ1!']?.position);
  check('mock a1:MNQ has 7 working orders', state['a1:MNQ1!']?.workingOrders?.length === 7,
    `${state['a1:MNQ1!']?.workingOrders?.length}`);
  check('mock a2:MNQ has 8 working orders', state['a2:MNQ1!']?.workingOrders?.length === 8,
    `${state['a2:MNQ1!']?.workingOrders?.length}`);

  check('closing bracket monitor closed',
    monitor(A1, wireId('PT-MNQ-A', bid('PT-MNQ-A', 'short')))?.state === 'closed'
    && monitor(A2, wireId('PT-MNQ-A', bid('PT-MNQ-A', 'short')))?.state === 'closed');
  const replacements = q1(`SELECT COUNT(*) c FROM bracket_monitor WHERE bracket_id LIKE 'bridge-reapply-%' AND state='armed' AND created_at >= ?${scopeSql}`, RUN_START, ...scopeArgs).c;
  check('15 armed replacement monitor rows', replacements === 15, `${replacements}`);
  const jrnl = q1("SELECT COUNT(*) c FROM range_trade_events WHERE range_name='PT-MNQ-A' AND event_type='trade_closed' AND occurred_at >= ?", RUN_START).c;
  check('trade_closed journaled for the range', jrnl === 1, `${jrnl}`);
}

// ============================================================================
console.log('\n=== P4a: phantom fill does NOT block cleanup (MGC-C filled, no dispatch) ===');
phase = 'P4a';
{
  const callsBefore = (await mockCalls()).length;
  await proxy(cancelEvt('PT-MGC-D', 'MGC1!', 'long', bid('PT-MGC-D', 'long')));
  const r = await proxy(close('PT-MGC-D', 'MGC1!', 'short', bid('PT-MGC-D', 'short'), { exitPrice: 2410 }));
  check('close accepted', r.status === 202);

  await waitFor(async () => {
    const calls = (await mockCalls()).slice(callsBefore);
    return callsFor(calls, (c) => c.payload.ticker === 'MGC1!' && c.payload.action === 'exit').length >= 1 ? calls : undefined;
  }, 30000);
  const calls = (await mockCalls()).slice(callsBefore);
  const mgc = callsFor(calls, (c) => c.payload.ticker === 'MGC1!');
  check('cancel dispatched despite phantom fill', mgc.some((c) => c.payload.action === 'cancel'));
  check('exit dispatched despite phantom fill', mgc.some((c) => c.payload.action === 'exit'));
  const rearms = mgc.filter((c) => c.payload.action === 'buy' || c.payload.action === 'sell');
  check('4 MGC re-arms (A+B)', rearms.length === 4, `${rearms.length}`);
}

// ============================================================================
console.log('\n=== P4b: REAL fill DOES block cleanup (MGC-B dispatched+acked+filled) ===');
phase = 'P4b';
{
  // Fill the re-armed MGC-B short — the alias maps Pine's fill onto the replacement.
  // The mock's working order sits under the fresh reapply bracket id, so mark
  // that order filled first; the P4b/P10 position checks then see real state.
  const replBracket = q1(`SELECT bracket_id b FROM broker_orders
    WHERE account_id=? AND range_name='PT-MGC-B' AND action='sell' AND status='acknowledged'
      AND bracket_id LIKE 'bridge-reapply-%' ORDER BY created_at DESC LIMIT 1`, A1)?.b;
  check('armed replacement bracket found for MGC-B short', typeof replBracket === 'string' && replBracket.length > 0, `${replBracket}`);
  if (replBracket) await mockFill(1, 'MGC1!', replBracket);
  await proxy(fill('PT-MGC-B', 'MGC1!', 'short', bid('PT-MGC-B', 'short')));
  await proxy(cancelEvt('PT-MGC-B', 'MGC1!', 'long', bid('PT-MGC-B', 'long')));
  await waitFor(() => {
    const row = q1(`SELECT bm.state FROM bracket_monitor bm
                    JOIN bracket_reapply_aliases a ON a.current_bracket_id = bm.bracket_id
                    WHERE a.original_bracket_id = ? AND bm.account_id = ?`, wireId('PT-MGC-B', bid('PT-MGC-B', 'short')), A1)
      ?? monitor(A1, wireId('PT-MGC-B', bid('PT-MGC-B', 'short')));
    return row?.state === 'filled' ? row : undefined;
  }, 10000);

  const callsBefore = (await mockCalls()).length;
  const r = await proxy(close('PT-MGC-C', 'MGC1!', 'short', bid('PT-MGC-C', 'short'), { exitPrice: 2410 }));
  check('close accepted', r.status === 202);
  await sleep(3000);
  const calls = (await mockCalls()).slice(callsBefore);
  const mgcCleanup = callsFor(calls, (c) => c.payload.ticker === 'MGC1!' && (c.payload.action === 'cancel' || c.payload.action === 'exit'));
  check('NO cancel/exit sent — real filled position blocks instrument cleanup', mgcCleanup.length === 0,
    `${mgcCleanup.length} cleanup calls`);
  check('close still journaled locally',
    q1("SELECT COUNT(*) c FROM range_trade_events WHERE range_name='PT-MGC-C' AND event_type='trade_closed' AND occurred_at >= ?", RUN_START).c === 1);
}

// ============================================================================
console.log('\n=== P5: outage — uncertain flatten legs; next close SUPERSEDES the wedge ===');
phase = 'P5';
{
  await setMode({ mode: 'error', status: 503 });
  const callsBefore = (await mockCalls()).length;
  await proxy(cancelEvt('PT-MNQ-B', 'MNQ1!', 'long', bid('PT-MNQ-B', 'long')));
  const r = await proxy(close('PT-MNQ-B', 'MNQ1!', 'short', bid('PT-MNQ-B', 'short'), { exitPrice: 29550 }));
  check('close accepted during outage', r.status === 202);
  await sleep(4000);

  const calls = (await mockCalls()).slice(callsBefore);
  const mnqCancel = callsFor(calls, (c) => c.payload.ticker === 'MNQ1!' && c.payload.action === 'cancel');
  const mnqExit = callsFor(calls, (c) => c.payload.ticker === 'MNQ1!' && c.payload.action === 'exit');
  check('cancel attempted during outage', mnqCancel.length >= 1, `${mnqCancel.length}`);
  // Flatten legs always run: the exit is attempted even though the cancel is uncertain.
  check('exit still attempted after uncertain cancel', mnqExit.length >= 1, `${mnqExit.length}`);

  const uncertain = q1(`SELECT COUNT(*) c FROM broker_orders WHERE status='uncertain' AND created_at >= ?${scopeSql}`, RUN_START, ...scopeArgs).c;
  check('failed flatten legs ledgered uncertain', uncertain >= 2, `${uncertain}`);
  check('local bookkeeping retired the bracket anyway',
    ['closed', 'cancelled'].includes(monitor(A1, wireId('PT-MNQ-B', bid('PT-MNQ-B', 'short')))?.state),
    monitor(A1, wireId('PT-MNQ-B', bid('PT-MNQ-B', 'short')))?.state);
  const paused = q(`SELECT * FROM reapply_operations WHERE completed = 0 AND event_id LIKE ?${scopeSql}`, `%-${TAG}-%`, ...scopeArgs);
  check('ops left incomplete (paused before re-arms)', paused.length >= 1, `${paused.length} incomplete`);

  // Supersede: mock healthy again, next close on the same instrument must clean up.
  await setMode({ mode: 'ok' });
  const callsBefore2 = (await mockCalls()).length;
  await proxy(cancelEvt('PT-MNQ-C', 'MNQ1!', 'long', bid('PT-MNQ-C', 'long')));
  const r2 = await proxy(close('PT-MNQ-C', 'MNQ1!', 'short', bid('PT-MNQ-C', 'short'), { exitPrice: 29550 }));
  check('next close accepted', r2.status === 202);
  const settled = await waitFor(async () => {
    const c2 = (await mockCalls()).slice(callsBefore2);
    const cleanup = callsFor(c2, (c) => c.payload.ticker === 'MNQ1!' && (c.payload.action === 'cancel' || c.payload.action === 'exit'));
    return cleanup.length >= 2 ? c2 : undefined;
  }, 30000);
  const calls2 = settled ?? (await mockCalls()).slice(callsBefore2);
  const newCleanup = callsFor(calls2, (c) => c.payload.ticker === 'MNQ1!' && (c.payload.action === 'cancel' || c.payload.action === 'exit'));
  check('next close supersedes the wedged op — fresh cleanup dispatched', newCleanup.length >= 2,
    `${newCleanup.length} cleanup calls`);
  const newRearms = callsFor(calls2, (c) => c.payload.ticker === 'MNQ1!' && (c.payload.action === 'buy' || c.payload.action === 'sell'));
  check('fresh plan re-arms the surviving ranges', newRearms.length >= 1, `${newRearms.length}`);

  const stale = ops().filter((o) => o.data.reason?.startsWith('Superseded'));
  check('wedged ops completed as superseded', stale.length >= 2, `${stale.length} superseded`);

  // Admin retry surface still works for anything left incomplete.
  const listRes = await adminApi('/admin/reapply-operations');
  check('admin ops list reachable', listRes.status === 200, `status=${listRes.status}`);
  const incomplete = (listRes.body?.operations ?? []).filter(op => [A1, A2].includes(op.accountId));
  console.log(`  NOTE  ${incomplete.length} incomplete ops remain`);
  for (const op of incomplete.slice(0, 3)) {
    const rr = await adminApi(`/admin/reapply-operations/${op.id}/retry`, { method: 'POST', body: '{}' });
    console.log(`  NOTE  retry ${op.id.slice(0, 8)}: status=${rr.status} ${JSON.stringify(rr.body ?? {}).slice(0, 140)}`);
  }
  await sleep(4000);
}

// ============================================================================
console.log('\n=== P6: races — concurrent closes on different instruments, same account ===');
phase = 'P6';
{
  const callsBefore = (await mockCalls()).length;
  const [r1, r2] = await Promise.all([
    proxy(close('PT-NQ-A', 'NQ1!', 'short', bid('PT-NQ-A', 'short'), { exitPrice: 21100 })),
    proxy(close('PT-ES-A', 'ES1!', 'short', bid('PT-ES-A', 'short'), { exitPrice: 6050 })),
  ]);
  check('both concurrent closes accepted', r1.status === 202 && r2.status === 202);
  await waitFor(async () => {
    const c = (await mockCalls()).slice(callsBefore);
    return callsFor(c, (x) => x.payload.ticker === 'NQ1!' && x.payload.action === 'exit').length >= 1
      && callsFor(c, (x) => x.payload.ticker === 'ES1!' && x.payload.action === 'exit').length >= 1 ? c : undefined;
  }, 30000);
  const c = (await mockCalls()).slice(callsBefore);
  check('NQ cleanup dispatched', callsFor(c, (x) => x.payload.ticker === 'NQ1!' && x.payload.action === 'cancel').length >= 1);
  check('ES cleanup dispatched', callsFor(c, (x) => x.payload.ticker === 'ES1!' && x.payload.action === 'cancel').length >= 1);
}

// ============================================================================
console.log('\n=== P7: timeout -> uncertain -> operator resend ===');
phase = 'P7';
{
  await setMode({ mode: 'timeout' });
  const late = `pt-es-b-late-${uid()}`;
  const p = proxy(entryOrder('PT-ES-B', 'ES1!', 'long', late));
  await waitFor(() => q1("SELECT COUNT(*) c FROM broker_orders WHERE bracket_id=? AND status='uncertain'", wireId('PT-ES-B', late)).c >= 1, 25000);
  check('timeout entry marked uncertain', q1("SELECT COUNT(*) c FROM broker_orders WHERE bracket_id=? AND status='uncertain'", wireId('PT-ES-B', late)).c === 1);
  await p;
  await setMode({ mode: 'ok' });

  const del = q1(`SELECT d.id FROM proxy_deliveries d JOIN broker_orders b ON b.proxy_delivery_id = d.id
                  WHERE b.bracket_id = ? ORDER BY d.created_at DESC LIMIT 1`, wireId('PT-ES-B', late));
  if (del) {
    const rr = await appApi(IDS.adminSession, '/app/api/journal/resend-delivery', {
      method: 'POST', json: { deliveryId: del.id },
    });
    check('operator resend accepted', rr.status === 200, `status=${rr.status} ${JSON.stringify(rr.body ?? '').slice(0, 100)}`);
    await waitFor(() => q1("SELECT COUNT(*) c FROM broker_orders WHERE bracket_id=? AND status='acknowledged'", wireId('PT-ES-B', late)).c >= 1, 20000);
    check('resent delivery acknowledged', q1("SELECT COUNT(*) c FROM broker_orders WHERE bracket_id=? AND status='acknowledged'", wireId('PT-ES-B', late)).c === 1);
    const attempts = q1(`SELECT COUNT(*) c FROM broker_orders WHERE bracket_id=?`, wireId('PT-ES-B', late)).c
      + q1(`SELECT COUNT(*) c FROM proxy_delivery_attempts WHERE proxy_delivery_id=?`, del.id).c;
    console.log(`  NOTE  ledger rows for ${late}: ${attempts}`);
  } else {
    check('found delivery row for resend', false, 'no proxy_deliveries row');
  }
}

console.log('\n=== P7b: transport failure -> single auto-retry -> acknowledged ===');
phase = 'P7b';
{
  await setMode({ mode: 'connreset' }); // destroys the next socket once, then reverts to ok
  const bid = `pt-es-a-transport-${uid()}`;
  const p = proxy(entryOrder('PT-ES-A', 'ES1!', 'long', bid));
  await waitFor(() => q1("SELECT COUNT(*) c FROM broker_orders WHERE bracket_id=? AND status='acknowledged'", wireId('PT-ES-A', bid)).c >= 1, 25000);
  check('transport-failed entry auto-retried to acknowledged',
    q1("SELECT COUNT(*) c FROM broker_orders WHERE bracket_id=? AND status='acknowledged'", wireId('PT-ES-A', bid)).c === 1);
  await p;
  await setMode({ mode: 'ok' });
  const del = q1(`SELECT d.id FROM proxy_deliveries d JOIN broker_orders b ON b.proxy_delivery_id = d.id
                  WHERE b.bracket_id = ? ORDER BY d.created_at DESC LIMIT 1`, wireId('PT-ES-A', bid));
  check('both sends ledgered as delivery attempts',
    !!del && q1('SELECT COUNT(*) c FROM proxy_delivery_attempts WHERE proxy_delivery_id=?', del.id).c >= 2,
    del ? `attempts=${q1('SELECT COUNT(*) c FROM proxy_delivery_attempts WHERE proxy_delivery_id=?', del.id).c}` : 'no delivery row');
}

// ============================================================================
console.log('\n=== P8: range management APIs ===');
phase = 'P8';
{
  const admin = IDS.adminSession;
  let r = await appApi(admin, '/app/tracked-ranges', { method: 'POST', form: { rangeName: 'PT-MNQ-A' } });
  check('duplicate add -> 409 + reason', r.status === 409 && /already exists/.test(r.body?.error ?? ''), `${r.status} ${r.body?.error}`);
  r = await appApi(admin, '/app/tracked-ranges', { method: 'POST', form: { rangeName: 'pt-mnq-a' } });
  check('case-variant duplicate -> 409', r.status === 409 && /already exists/.test(r.body?.error ?? ''));
  r = await appApi(admin, '/app/tracked-ranges', { method: 'POST', form: { rangeName: '   ' } });
  check('blank name -> 400 + reason', r.status === 400 && !!r.body?.error, `${r.status} ${r.body?.error}`);
  r = await appApi(admin, '/app/tracked-ranges', { method: 'POST', form: { rangeName: `PT-NEW-${TAG}` } });
  check('new range -> 303', r.status === 303, `${r.status}`);
  r = await appApi(admin, '/app/tracked-ranges', { method: 'POST', form: { rangeName: `PT-NEW-${TAG}` } });
  check('newly added range then duplicates -> 409', r.status === 409, `${r.status}`);

  r = await appApi(admin, '/app/api/range-configurations/bulk-days', { method: 'POST', json: { subcategoryName: 'PT-MOMENTUM', enabled: false } });
  check('bulk-days MOMENTUM off -> updated 4', r.status === 200 && r.body?.updated === 4, JSON.stringify(r.body));
  // Named models write per-range ASSIGNMENT days — the range's own config
  // flags are intentionally untouched.
  const off = q1(`SELECT COUNT(*) c FROM range_subcategory_assignments WHERE subcategory_name='PT-MOMENTUM' AND run_monday=0`).c;
  check('MOMENTUM assignment rows updated', off === 4, `${off}`);
  const configUntouched = q1(`SELECT COUNT(*) c FROM range_configurations WHERE range_name IN ('PT-MNQ-A','PT-MNQ-B','PT-MNQ-C','PT-MNQ-D') AND run_monday=1`).c;
  check('MOMENTUM range configs untouched', configUntouched === 4, `${configUntouched}`);
  r = await appApi(admin, '/app/api/range-configurations/bulk-days', { method: 'POST', json: { subcategoryName: 'PT-MOMENTUM', enabled: true } });
  check('bulk-days MOMENTUM back on', r.status === 200 && r.body?.updated === 4);
  r = await appApi(admin, '/app/api/range-configurations/bulk-days', { method: 'POST', json: { subcategoryName: 'NOPE', enabled: true } });
  check('unknown category -> updated 0', r.status === 200 && r.body?.updated === 0, JSON.stringify(r.body));
  if (!SHARED) {
    // The uncategorized sweep would rewrite real ranges' schedules on a shared DB.
    r = await appApi(admin, '/app/api/range-configurations/bulk-days', { method: 'POST', json: { subcategoryName: '', enabled: false } });
    check('uncategorized bulk-days -> updated 6 (PT-NEW-1 has no config)', r.status === 200 && r.body?.updated === 6, JSON.stringify(r.body));
    await appApi(admin, '/app/api/range-configurations/bulk-days', { method: 'POST', json: { subcategoryName: '', enabled: true } });
  }
}

// ============================================================================
console.log('\n=== P9: observability + access control ===');
phase = 'P9';
{
  const adm = await appApi(IDS.adminSession, '/app/api/monitoring');
  check('admin sees processRuns', adm.status === 200 && Array.isArray(adm.body?.processRuns) && adm.body.processRuns.length >= 1,
    `runs=${adm.body?.processRuns?.length}`);
  const vw = await appApi(IDS.viewerSession, '/app/api/monitoring');
  check('viewer gets empty processRuns', vw.status === 200 && (vw.body?.processRuns?.length ?? -1) === 0,
    `runs=${vw.body?.processRuns?.length}`);
  const dbg = await appApi(IDS.viewerSession, '/app/api/debugging');
  check('viewer blocked from debugging API', dbg.status === 401 || dbg.status === 403, `status=${dbg.status}`);
  const run = q1('SELECT * FROM process_runs ORDER BY started_at DESC LIMIT 1');
  check('process_runs row exists for this boot', !!run);
}

// ============================================================================
console.log('\n=== P10: exit-all-safeguard — flatten everything remaining ===');
phase = 'P10';
{
  const callsBefore = (await mockCalls()).length;
  for (const [label, acctId] of [['acct1', A1], ['acct2', A2]]) {
    const r = await appApi(IDS.adminSession, '/app/exit-all-safeguard', { method: 'POST', json: { accountId: acctId } });
    check(`safeguard accepted (${label})`, r.status === 200, `status=${r.status} sent=${r.body?.sent} errors=${r.body?.errors}`);
  }
  await waitFor(async () => {
    const c = (await mockCalls()).slice(callsBefore);
    return callsFor(c, (x) => x.payload.action === 'exit').length >= 4 ? c : undefined;
  }, 45000);
  const c = (await mockCalls()).slice(callsBefore);
  const flatExits = callsFor(c, (x) => x.payload.action === 'exit' && x.payload.extras?.cancelAll === true);
  check('safeguard exits with cancelAll dispatched', flatExits.length === 7, `${flatExits.length}`);
  check('safeguard swept MNQ+MGC on both accounts',
    ['a1:MNQ1!', 'a1:MGC1!', 'a2:MNQ1!', 'a2:MGC1!'].every((k) =>
      flatExits.some((x) => `${x.book}:${x.payload.ticker}` === k)));
  const openLeft = q1(`SELECT COUNT(*) c FROM bracket_monitor WHERE state IN ('armed','filled')${scopeSql}`, ...scopeArgs).c;
  check('all monitor rows retired', openLeft === 0, `${openLeft} still open`);
  const state = await mockState();
  const working = Object.values(state).reduce((n, t) => n + t.workingOrders.length, 0);
  const positions = Object.values(state).filter((t) => t.position).length;
  check('mock books flat — no working orders', working === 0, `${working}`);
  check('mock books flat — no positions', positions === 0, `${positions}`);

  // The retained artifact must carry finalized classification, not stale
  // accepted:false placeholders (timeout receipts are the one null-status row).
  const artifact = fs.readFileSync(path.join(WORKDIR, 'tp-calls.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('call artifact finalized — every record classified',
    artifact.length > 0 && artifact.every((r) =>
      typeof r.accepted === 'boolean' && (typeof r.responseStatus === 'number' || r.responseStatus === null)),
    `${artifact.length} records`);
  check('call artifact includes timeout receipt', artifact.some((r) => r.responseStatus === null));
  check('call artifact includes rejected/uncertain dispatch', artifact.some((r) => r.accepted === false && r.responseStatus !== null));
}

// ============================================================================
const fails = results.filter((r) => !r.ok);
console.log(`\n================ SUMMARY ================`);
console.log(`${results.length - fails.length}/${results.length} checks passed`);
if (fails.length) {
  for (const f of fails) console.log(`FAIL [${f.phase}] ${f.name} — ${f.detail}`);
  process.exit(1);
}
console.log('all green');
